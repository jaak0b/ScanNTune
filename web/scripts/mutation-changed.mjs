// Runs Stryker on the engine source files changed relative to master (committed on the branch,
// staged, unstaged, and untracked), so a local `npm run mutation` never mutates the full scope.
// Full-scope runs (`npm run mutation:full`) belong to CI only (the Mutation Testing workflow).
// Exits 0 with a message when no in-scope engine file changed. Pass --list to print the
// selected files without running Stryker.
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const webDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

function git(args) {
  return execFileSync('git', args, { cwd: webDir, encoding: 'utf8' })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

// Committed changes on this branch relative to master, plus every working-tree change.
const committed = git(['diff', '--name-only', 'master...HEAD'])
const workingTree = git(['status', '--porcelain']).map((line) => {
  const entry = line.slice(3)
  const arrow = entry.indexOf(' -> ')
  return arrow >= 0 ? entry.slice(arrow + 4) : entry
})
const repoRoot = git(['rev-parse', '--show-toplevel'])[0]
const webPrefix = path.relative(repoRoot, webDir).replaceAll('\\', '/') + '/'

// Mirror of the mutate scope in stryker.config.mjs: keep the two lists in step.
const excluded = [
  /^src\/engine\/opencv\.ts$/,
  /^src\/engine\/imageData\.ts$/,
  /^src\/engine\/cvUtils\.ts$/,
  /^src\/engine\/(.+\/)?types\.ts$/,
  /^src\/engine\/is\/resultTypes\.ts$/,
  /^src\/engine\/(.+\/)?[a-zA-Z]*[oO]verlayRenderer\.ts$/,
  /^src\/engine\/ringDetector\.ts$/,
  /^src\/engine\/cardEdgeMeasurer\.ts$/,
  /^src\/engine\/couponAnalyzer\.ts$/,
  /^src\/engine\/planeIdReader\.ts$/,
  /^src\/engine\/subpixelEdge\.ts$/,
  /^src\/engine\/em\/emAnalyzer\.ts$/,
  /^src\/engine\/em\/fiducialAligner\.ts$/,
  /^src\/engine\/em\/gapMeasurer\.ts$/,
  /^src\/engine\/pa\/fiducialAligner\.ts$/,
  /^src\/engine\/pa\/lineMeasurer\.ts$/,
  /^src\/engine\/pa\/paAnalyzer\.ts$/,
  /^src\/engine\/is\/isAnalyzer\.ts$/,
  /^src\/engine\/is\/isFiducialAligner\.ts$/,
  /^src\/engine\/is\/lineTracer\.ts$/,
]

const changed = [...new Set([...committed, ...workingTree])]
  .filter((f) => f.startsWith(webPrefix))
  .map((f) => f.slice(webPrefix.length))
  .filter((f) => f.startsWith('src/engine/') && f.endsWith('.ts'))
  .filter((f) => !excluded.some((re) => re.test(f)))

if (changed.length === 0) {
  console.log('No engine source files changed relative to master; nothing to mutate.')
  console.log('For a targeted run: npx stryker run --mutate src/engine/<module>.ts')
  process.exit(0)
}

console.log('Mutating changed engine files:')
for (const f of changed) console.log(`  ${f}`)
if (process.argv.includes('--list')) process.exit(0)
const result = spawnSync('npx', ['stryker', 'run', '--mutate', changed.join(',')], {
  cwd: webDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
process.exit(result.status ?? 1)
