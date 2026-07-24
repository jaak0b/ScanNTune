// Evaluate OrcaSlicer / PrusaSlicer start-G-code template syntax for a SINGLE-TOOL print (the PA
// coupon is always one extruder). Pure and framework-agnostic: it knows nothing about printer or
// filament profiles. The caller supplies `resolveSetting`, which maps a slicer setting name to its
// string value (or null if the name is unknown); this module layers the tool-index model, indexed
// setting access, and {if}/{elif}/{else}/{endif} conditionals on top of it.
//
// Single-tool model: the initial/current extruder is 0, and is_extruder_used[N] is true iff N === 0.

/** A slicer setting resolver: setting name to its value, or null when the name is not mapped. */
export type SettingResolver = (name: string) => string | null

export interface TemplateResult {
  text: string
  /** Genuinely-unknown simple placeholder names, deduplicated. Never control keywords. */
  unknown: string[]
  /** User-facing warnings, e.g. a conditional that could not be evaluated. Deduplicated. */
  warnings: string[]
}

const UNEVALUATED_CONDITION_WARNING = 'A conditional block could not be evaluated; review it.'

// Tool-index constants that resolve to the single active extruder, 0.
const TOOL_INDEX_VARS = new Set(['initial_tool', 'current_extruder', 'initial_extruder'])

// Control keywords that must never be reported as unknown variables.
const CONTROL_KEYWORDS = new Set(['if', 'elif', 'else', 'endif'])

/**
 * Evaluate template syntax against `resolveSetting`. Conditionals are resolved first (false
 * branches dropped, unevaluable blocks left literal with one warning), then remaining placeholders
 * are substituted, then genuinely-unknown simple placeholders are collected.
 */
export function evaluateTemplate(source: string, resolveSetting: SettingResolver): TemplateResult {
  const unknown = new Set<string>()
  const warnings = new Set<string>()
  const afterConditionals = evaluateConditionals(source, resolveSetting, warnings)
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
function evaluateConditionals(source: string, resolveSetting: SettingResolver, warnings: Set<string>): string {
  const tokens = tokenize(source)
  const { text } = renderTokens(tokens, 0, resolveSetting, warnings)
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
  resolveSetting: SettingResolver,
  warnings: Set<string>,
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
      out += renderBlock(block, tokens, resolveSetting, warnings)
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
function renderBlock(block: ParsedBlock, _tokens: Token[], resolveSetting: SettingResolver, warnings: Set<string>): string {
  if (!block.balanced) {
    warnings.add(UNEVALUATED_CONDITION_WARNING)
    return block.raw
  }
  for (const branch of block.branches) {
    if (branch.cond === null) continue
    const value = evaluateCondition(branch.cond, resolveSetting)
    if (value === null) {
      warnings.add(UNEVALUATED_CONDITION_WARNING)
      return block.raw
    }
  }
  for (const branch of block.branches) {
    const taken = branch.cond === null || evaluateCondition(branch.cond, resolveSetting) === true
    if (taken) {
      return renderTokens(branch.tokens, 0, resolveSetting, warnings).text
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
  | { kind: 'not'; arg: Expr }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }

/**
 * Evaluate a condition expression to a boolean, or null if it contains anything the bounded grammar
 * does not understand (so the caller leaves the whole block literal). Grammar: integer literals;
 * is_extruder_used[N]; the tool-index constants (= 0); == != < > <= >=; and/or/not; parentheses.
 */
export function evaluateCondition(source: string, resolveSetting: SettingResolver): boolean | null {
  const tokens = lex(source, resolveSetting)
  if (tokens === null) return null
  const parser = new Parser(tokens)
  const expr = parser.parseExpression()
  if (expr === null || !parser.atEnd()) return null
  const value = evalExpr(expr)
  return typeof value === 'boolean' ? value : value !== 0
}

type Lexeme =
  | { t: 'num'; v: number }
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
      let nextI = i
      if (nextI < s.length && s[nextI] === '[') {
        const parsed = parseIndex(s, nextI)
        if (parsed !== null) nextI = parsed.next
      }
      const valStr = resolveSetting(word)
      if (valStr !== null) {
        i = nextI
        const numVal = Number(valStr)
        if (!Number.isNaN(numVal)) {
          out.push({ t: 'num', v: numVal })
          continue
        }
      }
      // Unknown identifier: whole condition is unevaluable.
      return null
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
    return null
  }
}

function evalExpr(expr: Expr): number | boolean {
  switch (expr.kind) {
    case 'num':
      return expr.value
    case 'bool':
      return expr.value
    case 'not':
      return !toBool(evalExpr(expr.arg))
    case 'binary': {
      if (expr.op === 'and') return toBool(evalExpr(expr.left)) && toBool(evalExpr(expr.right))
      if (expr.op === 'or') return toBool(evalExpr(expr.left)) || toBool(evalExpr(expr.right))
      const l = toNum(evalExpr(expr.left))
      const r = toNum(evalExpr(expr.right))
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

function toBool(v: number | boolean): boolean {
  return typeof v === 'boolean' ? v : v !== 0
}

function toNum(v: number | boolean): number {
  return typeof v === 'number' ? v : v ? 1 : 0
}

// ---------------------------------------------------------------------------
// Placeholder substitution
// ---------------------------------------------------------------------------

// A placeholder is [name] or {name}, with an optional index [idx] or [name[idx]] / {name[idx]}. The
// index is a number or an identifier (resolved as a tool constant); its value is ignored because
// settings are single-valued here. Anything else (jinja {% %}, dotted {a.b}) is not matched.
const PLACEHOLDER =
  /\[([A-Za-z_][A-Za-z0-9_]*)(?:\[([A-Za-z0-9_]+)\])?\]|\{([A-Za-z_][A-Za-z0-9_]*)(?:\[([A-Za-z0-9_]+)\])?\}/g

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
      if (idx !== undefined && resolveIndexToken(idx) === null) return match
      if (CONTROL_KEYWORDS.has(name)) return match
      if (TOOL_INDEX_VARS.has(name)) return '0'
      const value = resolveSetting(name)
      if (value === null) {
        unknown.add(name)
        return match
      }
      return value
    },
  )
}
