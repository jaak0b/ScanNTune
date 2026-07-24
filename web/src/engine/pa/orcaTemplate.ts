// Evaluate OrcaSlicer / PrusaSlicer start-G-code template syntax for a SINGLE-TOOL print (the PA
// coupon is always one extruder). Pure and framework-agnostic: it knows nothing about printer or
// filament profiles. The caller supplies `resolveSetting`, which maps a slicer setting name to its
// string value (or null if the name is unknown); this module layers the tool-index model, indexed
// setting access, and {if}/{elif}/{else}/{endif} conditionals on top of it.
//
// Single-tool model: the initial/current extruder is 0, and is_extruder_used[N] is true iff N === 0.

/**
 * A slicer setting resolver: setting name (and, for an indexed vector setting such as the plate
 * bounding box, the numeric index) to its value, or null when the name (or that index of it) is
 * not mapped. `idx` is omitted for a plain, unindexed placeholder reference.
 */
export type SettingResolver = (name: string, idx?: number) => string | null

export interface TemplateResult {
  text: string
  /** Genuinely-unknown simple placeholder names, deduplicated. Never control keywords. */
  unknown: string[]
  /** User-facing warnings, e.g. a conditional that could not be evaluated. Deduplicated. */
  warnings: string[]
}

/** One user-facing warning for a conditional block that could not be evaluated: names the
 *  construct (its condition, or the condition's first line if it spans several), and states
 *  that the whole block was left in the G-code untouched. */
function unevaluatedConditionWarning(conditionSource: string): string {
  const firstLine = conditionSource.split('\n')[0].trim()
  return (
    `The conditional "{if ${firstLine}}" could not be evaluated, so the whole block was left ` +
    'in the G-code exactly as written. Review the block in your start G-code, and either fix ' +
    'the condition or replace the block with the lines from the branch you intend to use.'
  )
}

/** One user-facing warning for a placeholder that holds a slicer arithmetic expression (e.g.
 *  `{retraction_length[0]*0.75}`) rather than a plain variable reference: names the exact
 *  expression and states that it was left untouched because this tool does not evaluate
 *  slicer arithmetic. */
function unevaluatedExpressionWarning(expressionText: string): string {
  return (
    `The expression "${expressionText}" was left exactly as written in the G-code. This tool ` +
    'does not evaluate slicer arithmetic expressions. Replace the whole expression with the ' +
    'computed number before printing.'
  )
}

// Tool-index constants that resolve to the single active extruder, 0.
export const TOOL_INDEX_VARS = new Set(['initial_tool', 'current_extruder', 'initial_extruder'])

// Control keywords that must never be reported as unknown variables.
const CONTROL_KEYWORDS = new Set(['if', 'elif', 'else', 'endif'])

/**
 * Evaluate template syntax against `resolveSetting`. Conditionals are resolved first (false
 * branches dropped, unevaluable blocks left literal with one warning), then remaining placeholders
 * are substituted, then genuinely-unknown simple placeholders are collected.
 */
export function evaluateTemplate(
  source: string,
  resolveSetting: SettingResolver,
  isKnownVariable?: (name: string) => boolean,
): TemplateResult {
  const unknown = new Set<string>()
  const warnings = new Set<string>()
  const afterConditionals = evaluateConditionals(source, warnings, resolveSetting)
  if (isKnownVariable) {
    detectExpressionPlaceholders(afterConditionals, isKnownVariable, warnings)
  }
  const text = substitutePlaceholders(afterConditionals, resolveSetting, unknown)
  return { text, unknown: [...unknown], warnings: [...warnings] }
}

// ---------------------------------------------------------------------------
// Conditional blocks
// ---------------------------------------------------------------------------

interface Token {
  kind: 'if' | 'elif' | 'else' | 'endif' | 'text'
  /** The full literal source of the token (used when a block is left unevaluated). */
  raw: string
  /** For 'if'/'elif': the condition expression source. */
  cond?: string
}

// {if COND}, {elif COND}, {else}, {endif}. COND is captured lazily up to the closing brace; brace
// nesting is not expected inside a condition.
const CONTROL_TOKEN = /\{(if|elif|else|endif)\b([^}]*)\}/g

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let last = 0
  for (let m = CONTROL_TOKEN.exec(source); m !== null; m = CONTROL_TOKEN.exec(source)) {
    if (m.index > last) tokens.push({ kind: 'text', raw: source.slice(last, m.index) })
    const kind = m[1] as 'if' | 'elif' | 'else' | 'endif'
    tokens.push({ kind, raw: m[0], cond: m[2].trim() })
    last = m.index + m[0].length
  }
  if (last < source.length) tokens.push({ kind: 'text', raw: source.slice(last) })
  return tokens
}

/**
 * Resolve every top-level {if}...{endif} block, recursing into the kept branch. An unbalanced or
 * unevaluable block is emitted verbatim (with one warning) so nothing is partially mangled.
 */
function evaluateConditionals(
  source: string,
  warnings: Set<string>,
  resolveSetting: SettingResolver,
): string {
  const tokens = tokenize(source)
  const { text } = renderTokens(tokens, 0, warnings, resolveSetting)
  return text
}

interface Branch {
  cond: string | null // null for the {else} branch
  tokens: Token[]
}

/** Render tokens from `start` until a token that ends the current block, returning the text and the
 * index just past where rendering stopped. `stopAt` names the tokens that terminate this level. */
function renderTokens(
  tokens: Token[],
  start: number,
  warnings: Set<string>,
  resolveSetting: SettingResolver,
): { text: string; next: number } {
  let out = ''
  let i = start
  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok.kind === 'text') {
      out += tok.raw
      i++
    } else if (tok.kind === 'if') {
      const block = parseBlock(tokens, i)
      out += renderBlock(block, tokens, warnings, resolveSetting)
      i = block.end
    } else {
      // A stray elif/else/endif with no opening if: leave it literal so nothing is lost.
      out += tok.raw
      i++
    }
  }
  return { text: out, next: i }
}

interface ParsedBlock {
  branches: Branch[]
  /** Index just past the matching {endif}. */
  end: number
  /** True when the {if}...{endif} was balanced. */
  balanced: boolean
  /** Full literal source of the whole block, for the unevaluated fallback. */
  raw: string
}

/** Parse one {if}...{endif} starting at the {if} token index `open`, honoring nested ifs. */
function parseBlock(tokens: Token[], open: number): ParsedBlock {
  const branches: Branch[] = []
  let current: Branch = { cond: tokens[open].cond ?? '', tokens: [] }
  let raw = tokens[open].raw
  let depth = 1
  let i = open + 1
  for (; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.kind === 'if') {
      depth++
      current.tokens.push(tok)
      raw += tok.raw
    } else if (tok.kind === 'endif') {
      depth--
      raw += tok.raw
      if (depth === 0) {
        branches.push(current)
        return { branches, end: i + 1, balanced: true, raw }
      }
      current.tokens.push(tok)
    } else if (tok.kind === 'elif' && depth === 1) {
      branches.push(current)
      current = { cond: tok.cond ?? '', tokens: [] }
      raw += tok.raw
    } else if (tok.kind === 'else' && depth === 1) {
      branches.push(current)
      current = { cond: null, tokens: [] }
      raw += tok.raw
    } else {
      current.tokens.push(tok)
      raw += tok.raw
    }
  }
  // Reached end without a matching {endif}: unbalanced.
  branches.push(current)
  return { branches, end: i, balanced: false, raw }
}

/** Render a parsed block: pick the first branch whose condition is true, recursing into it. If any
 * condition is unevaluable (or the block is unbalanced), emit the whole block literally + warn. */
function renderBlock(
  block: ParsedBlock,
  _tokens: Token[],
  warnings: Set<string>,
  resolveSetting: SettingResolver,
): string {
  const conditionSource = block.branches[0]?.cond ?? block.raw.split('\n')[0]
  if (!block.balanced) {
    warnings.add(unevaluatedConditionWarning(conditionSource))
    return block.raw
  }
  for (const branch of block.branches) {
    if (branch.cond === null) continue
    const value = evaluateCondition(branch.cond, resolveSetting)
    if (value === null) {
      warnings.add(unevaluatedConditionWarning(conditionSource))
      return block.raw
    }
  }
  for (const branch of block.branches) {
    const taken = branch.cond === null || evaluateCondition(branch.cond, resolveSetting) === true
    if (taken) {
      return renderTokens(branch.tokens, 0, warnings, resolveSetting).text
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// Boolean condition evaluator
// ---------------------------------------------------------------------------

type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'str'; value: string }
  | { kind: 'not'; arg: Expr }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }

/**
 * Evaluate a condition expression to a boolean, or null if it contains anything the bounded grammar
 * does not understand (so the caller leaves the whole block literal). Grammar: integer literals;
 * quoted string literals; is_extruder_used[N]; the tool-index constants (= 0); any variable
 * `resolveSetting` knows, bare (e.g. `layer_height`) or indexed (e.g. `retraction_length[0]`,
 * `first_layer_print_min[0]`), resolved via the SAME resolver the placeholder substitution layer
 * uses, so a condition can reference anything a placeholder can; == != < > <= >=; and/or/not;
 * parentheses. String-valued variables support only == and != against another string (a quoted
 * literal or another string-valued variable); comparing a string to a number, or using a string
 * with <, >, <=, >=, and, or, makes the whole condition unevaluable, never silently coerced.
 * `resolveSetting` defaults to resolving nothing, so a bare condition check (as in tests) still
 * treats any variable outside the built-in constants as unevaluable.
 */
export function evaluateCondition(
  source: string,
  resolveSetting: SettingResolver = () => null,
): boolean | null {
  const tokens = lex(source, resolveSetting)
  if (tokens === null) return null
  const parser = new Parser(tokens)
  const expr = parser.parseExpression()
  if (expr === null || !parser.atEnd()) return null
  if (hasTypeMismatch(expr)) return null
  const value = evalExpr(expr)
  return typeof value === 'boolean' ? value : value !== 0
}

type Lexeme =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'used'; v: number } // is_extruder_used[N] resolved to a boolean literal

const OPERATORS = ['<=', '>=', '==', '!=', '<', '>']

function lex(source: string, resolveSetting: SettingResolver): Lexeme[] | null {
  const out: Lexeme[] = []
  let i = 0
  const s = source
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '(') {
      out.push({ t: 'lparen' })
      i++
      continue
    }
    if (c === ')') {
      out.push({ t: 'rparen' })
      i++
      continue
    }
    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      while (j < s.length && s[j] !== quote) j++
      if (j >= s.length) return null // unterminated string literal
      out.push({ t: 'str', v: s.slice(i + 1, j) })
      i = j + 1
      continue
    }
    const two = s.slice(i, i + 2)
    const op = OPERATORS.find((o) => (o.length === 2 ? two === o : s[i] === o))
    if (op) {
      out.push({ t: 'op', v: op })
      i += op.length
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < s.length && /[0-9]/.test(s[j])) j++
      if (s[j] === '.' && /[0-9]/.test(s[j + 1] ?? '')) {
        j++
        while (j < s.length && /[0-9]/.test(s[j])) j++
      }
      out.push({ t: 'num', v: Number(s.slice(i, j)) })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++
      const word = s.slice(i, j)
      i = j
      if (word === 'and' || word === 'or' || word === 'not') {
        out.push({ t: 'op', v: word })
        continue
      }
      if (TOOL_INDEX_VARS.has(word)) {
        out.push({ t: 'num', v: 0 })
        continue
      }
      if (word === 'is_extruder_used') {
        // Expect [ <index> ].
        const parsed = parseIndex(s, i)
        if (parsed === null) return null
        out.push({ t: 'used', v: parsed.index === 0 ? 1 : 0 })
        i = parsed.next
        continue
      }
      // Any other variable the substitution layer knows, indexed (e.g.
      // first_layer_print_min[0], retraction_length[0]) or bare (e.g. layer_height): resolved
      // through the SAME resolveSetting used for placeholder substitution, so a condition can
      // reference anything a placeholder can. An unresolved reference is unevaluable.
      const indexed = parseIndex(s, i)
      const value = indexed !== null ? resolveSetting(word, indexed.index) : resolveSetting(word)
      if (value === null) return null
      out.push(valueToLexeme(value))
      if (indexed !== null) i = indexed.next
      continue
    }
    return null
  }
  return out
}

/** Parse `[ <number-or-tool-const> ]` starting at index `i` (just past the identifier). */
function parseIndex(s: string, i: number): { index: number; next: number } | null {
  let k = i
  while (k < s.length && /\s/.test(s[k])) k++
  if (k >= s.length || s[k] !== '[') return null
  k++
  while (k < s.length && /\s/.test(s[k])) k++
  let j = k
  while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++
  const inner = s.slice(k, j)
  const index = resolveIndexToken(inner)
  if (index === null) return null
  k = j
  while (k < s.length && /\s/.test(s[k])) k++
  if (k >= s.length || s[k] !== ']') return null
  return { index, next: k + 1 }
}

/** A numeric index literal or a tool-index constant resolves to a number; else null. */
function resolveIndexToken(token: string): number | null {
  if (/^[0-9]+$/.test(token)) return Number(token)
  if (TOOL_INDEX_VARS.has(token)) return 0
  return null
}

/** A resolved setting value lexes as a number when it parses as one (the normal case: every
 *  numeric slicer setting), otherwise as a string (e.g. filament_type's "PETG"). */
function valueToLexeme(value: string): Lexeme {
  const trimmed = value.trim()
  const num = Number(trimmed)
  return trimmed !== '' && Number.isFinite(num) ? { t: 'num', v: num } : { t: 'str', v: value }
}

class Parser {
  private pos = 0
  constructor(private readonly tokens: Lexeme[]) {}

  atEnd(): boolean {
    return this.pos >= this.tokens.length
  }

  private peek(): Lexeme | undefined {
    return this.tokens[this.pos]
  }

  private isOp(v: string): boolean {
    const tok = this.peek()
    return tok !== undefined && tok.t === 'op' && tok.v === v
  }

  // expression := or
  parseExpression(): Expr | null {
    return this.parseOr()
  }

  private parseOr(): Expr | null {
    let left = this.parseAnd()
    if (left === null) return null
    while (this.isOp('or')) {
      this.pos++
      const right = this.parseAnd()
      if (right === null) return null
      left = { kind: 'binary', op: 'or', left, right }
    }
    return left
  }

  private parseAnd(): Expr | null {
    let left = this.parseNot()
    if (left === null) return null
    while (this.isOp('and')) {
      this.pos++
      const right = this.parseNot()
      if (right === null) return null
      left = { kind: 'binary', op: 'and', left, right }
    }
    return left
  }

  private parseNot(): Expr | null {
    if (this.isOp('not')) {
      this.pos++
      const arg = this.parseNot()
      if (arg === null) return null
      return { kind: 'not', arg }
    }
    return this.parseComparison()
  }

  private parseComparison(): Expr | null {
    const left = this.parsePrimary()
    if (left === null) return null
    const tok = this.peek()
    if (tok !== undefined && tok.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(tok.v)) {
      this.pos++
      const right = this.parsePrimary()
      if (right === null) return null
      return { kind: 'binary', op: tok.v, left, right }
    }
    return left
  }

  private parsePrimary(): Expr | null {
    const tok = this.peek()
    if (tok === undefined) return null
    if (tok.t === 'lparen') {
      this.pos++
      const inner = this.parseExpression()
      if (inner === null) return null
      const close = this.peek()
      if (close === undefined || close.t !== 'rparen') return null
      this.pos++
      return inner
    }
    if (tok.t === 'num') {
      this.pos++
      return { kind: 'num', value: tok.v }
    }
    if (tok.t === 'used') {
      this.pos++
      return { kind: 'bool', value: tok.v === 1 }
    }
    if (tok.t === 'str') {
      this.pos++
      return { kind: 'str', value: tok.v }
    }
    return null
  }
}

/** The value type an expression node produces, used to reject a comparison that would otherwise
 *  silently coerce a string (e.g. comparing filament_type to a number, or ordering strings with
 *  <). Nested comparisons/booleans are typed 'bool'; 'not' is always 'bool'. */
type ValueType = 'num' | 'bool' | 'str'

function inferType(expr: Expr): ValueType {
  switch (expr.kind) {
    case 'num':
      return 'num'
    case 'bool':
      return 'bool'
    case 'str':
      return 'str'
    case 'not':
      return 'bool'
    case 'binary':
      return 'bool'
  }
}

/**
 * True if `expr` contains a comparison that mixes an incompatible type: a string used with a
 * relational operator (<, >, <=, >=), a string compared with == / != against a non-string, or a
 * string used as an and/or operand. Such a condition must be treated as unevaluable (rule: never
 * guess), not silently coerced (e.g. via NaN comparisons or JS's loose truthiness on strings).
 */
function hasTypeMismatch(expr: Expr): boolean {
  switch (expr.kind) {
    case 'num':
    case 'bool':
    case 'str':
      return false
    case 'not':
      return hasTypeMismatch(expr.arg)
    case 'binary': {
      if (hasTypeMismatch(expr.left) || hasTypeMismatch(expr.right)) return true
      const lt = inferType(expr.left)
      const rt = inferType(expr.right)
      if (lt !== 'str' && rt !== 'str') return false
      // At least one side is a string: only == / != between two strings is allowed.
      if (expr.op !== '==' && expr.op !== '!=') return true
      return lt !== rt
    }
  }
}

function evalExpr(expr: Expr): number | boolean | string {
  switch (expr.kind) {
    case 'num':
      return expr.value
    case 'bool':
      return expr.value
    case 'str':
      return expr.value
    case 'not':
      return !toBool(evalExpr(expr.arg))
    case 'binary': {
      if (expr.op === 'and') return toBool(evalExpr(expr.left)) && toBool(evalExpr(expr.right))
      if (expr.op === 'or') return toBool(evalExpr(expr.left)) || toBool(evalExpr(expr.right))
      const lVal = evalExpr(expr.left)
      const rVal = evalExpr(expr.right)
      if (typeof lVal === 'string' || typeof rVal === 'string') {
        // hasTypeMismatch already guarantees both sides are strings and the op is == or != here.
        return expr.op === '==' ? lVal === rVal : lVal !== rVal
      }
      const l = toNum(lVal)
      const r = toNum(rVal)
      switch (expr.op) {
        case '==':
          return l === r
        case '!=':
          return l !== r
        case '<':
          return l < r
        case '>':
          return l > r
        case '<=':
          return l <= r
        case '>=':
          return l >= r
      }
      return false
    }
  }
}

function toBool(v: number | boolean | string): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.length > 0
  return v !== 0
}

function toNum(v: number | boolean | string): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') return Number(v)
  return v ? 1 : 0
}

// ---------------------------------------------------------------------------
// Placeholder substitution
// ---------------------------------------------------------------------------

// A placeholder is [name] or {name}, with an optional index [idx] or [name[idx]] / {name[idx]}. The
// index is a number or an identifier (resolved as a tool constant); most settings here are
// single-valued and ignore it, but an indexed vector setting (e.g. first_layer_print_min[0]) uses
// it to pick the component. Anything else (jinja {% %}, dotted {a.b}) is not matched.
const PLACEHOLDER =
  /\[([A-Za-z_][A-Za-z0-9_]*)(?:\[([A-Za-z0-9_]+)\])?\]|\{([A-Za-z_][A-Za-z0-9_]*)(?:\[([A-Za-z0-9_]+)\])?\}/g

// A plain placeholder reference: identifier, or identifier[idx]. Used to tell an expression-shaped
// group apart from an ordinary variable placeholder (which substitutePlaceholders already handles).
const PLAIN_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[A-Za-z0-9_]+\])?$/

// A brace or bracket group that might hold a slicer arithmetic expression rather than a plain
// variable reference: `[...]` allows one embedded `[idx]` (for an indexed setting inside the
// expression, e.g. `retraction_length[0]*0.75`); `{...}` allows the same via its own character
// class. Control-flow braces ({if}, {elif}, {else}, {endif}) are excluded by the caller.
const EXPRESSION_GROUP = /\[([^[\]]*(?:\[[A-Za-z0-9_]+\])?[^[\]]*)\]|\{([^{}]*)\}/g

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g

/**
 * Find brace/bracket groups that are not plain variable placeholders (see PLAIN_REFERENCE) but
 * whose contents reference a recognized variable name, e.g. `{retraction_length[0]*0.75}`. These
 * are slicer arithmetic expressions this tool does not evaluate: they are left untouched by
 * substitutePlaceholders (the PLACEHOLDER regex does not match them), so this reports one warning
 * per distinct expression rather than leaving the user with no explanation at all.
 */
function detectExpressionPlaceholders(
  source: string,
  isKnownVariable: (name: string) => boolean,
  warnings: Set<string>,
): void {
  for (const m of source.matchAll(EXPRESSION_GROUP)) {
    const content = (m[1] ?? m[2] ?? '').trim()
    if (content === '') continue
    if (PLAIN_REFERENCE.test(content)) continue
    // {if COND}/{elif COND}/{else}/{endif} are control-flow tokens, not expressions; conditional
    // evaluation already reports its own warning for one it could not resolve.
    if (/^(if|elif|else|endif)\b/.test(content)) continue
    const referencesKnownVariable = [...content.matchAll(IDENTIFIER)].some(
      ([name]) => TOOL_INDEX_VARS.has(name) || isKnownVariable(name),
    )
    if (referencesKnownVariable) {
      warnings.add(unevaluatedExpressionWarning(m[0]))
    }
  }
}

function substitutePlaceholders(
  source: string,
  resolveSetting: SettingResolver,
  unknown: Set<string>,
): string {
  return source.replace(
    PLACEHOLDER,
    (match, sqName: string | undefined, sqIdx: string | undefined, cuName: string | undefined, cuIdx: string | undefined) => {
      const name = sqName ?? cuName
      const idx = sqName !== undefined ? sqIdx : cuIdx
      if (name === undefined) return match
      // If an index is present it must be a number or a tool constant; otherwise this is not a
      // setting reference we own, so leave it verbatim without reporting.
      const idxNum = idx !== undefined ? resolveIndexToken(idx) : null
      if (idx !== undefined && idxNum === null) return match
      if (CONTROL_KEYWORDS.has(name)) return match
      if (TOOL_INDEX_VARS.has(name)) return '0'
      const value = resolveSetting(name, idxNum ?? undefined)
      if (value === null) {
        unknown.add(name)
        return match
      }
      return value
    },
  )
}
