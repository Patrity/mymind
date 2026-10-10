// Cycle 80: move the core closure into packages/core/src (git mv) and rewrite imports.
//
//   tsx scripts/codemod-core-imports.ts --dry-run   print the plan, touch nothing
//   tsx scripts/codemod-core-imports.ts             git mv + rewrite
//
// What moves:
//   - every closure file (scripts/core-closure.ts): server/<x> -> packages/core/src/<x>,
//     shared/<x> -> packages/core/src/shared/<x>
//   - each *.test.ts sitting in a directory that holds closure files, when every repo-local
//     module it names (imports, vi.mock/doMock/importActual targets) is a closure file — a test
//     that also reaches non-closure code (app/, a sibling that stays) stays put and is rewritten
//     like any other outside importer
//   - a sibling `__fixtures__/` directory when every test in that directory that names it moves
//
// How imports are rewritten:
//   - inside moved files: a specifier naming another moved file becomes the relative path between
//     their NEW locations (identical to before for server->server, since the tree is preserved;
//     `~~/shared/...` and `../../../shared/...` become relative paths into src/shared)
//   - outside files (server/, app/, test/, shared/, scripts/): a specifier naming a moved file
//     becomes `@mymind/core/<path under src without .ts>`; a directory-style specifier (one that
//     resolved through `<dir>/index.ts`) stays directory-style, `@mymind/core/<dir>`, which
//     packages/core/package.json maps with one explicit `exports` entry per index dir
//   - npm specifiers and specifiers naming files that do not move are left byte-for-byte alone
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative } from 'node:path'
import { coreClosure, isLocalSpec, resolveSpec, ROOT } from './core-closure'

const CORE_SRC = 'packages/core/src'
const CONSUMER_ROOTS = ['server', 'app', 'test', 'shared', 'scripts']
const CODE_EXT = /\.(ts|mts|js|mjs|vue)$/

/** Every specifier context we rewrite: from '…', import('…'), import '…', vi.mock-family('…'). */
const SPEC_CTX = /(\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+|\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*(?:<[^>()]*>)?\s*\(\s*)(['"])([^'"\n]+)\2/gm

export function newPathFor(file: string): string {
  if (file.startsWith('server/')) return join(CORE_SRC, file.slice('server/'.length))
  if (file.startsWith('shared/')) return join(CORE_SRC, 'shared', file.slice('shared/'.length))
  throw new Error(`closure file outside server/ and shared/: ${file}`)
}

function specsIn(src: string): string[] {
  return [...src.matchAll(SPEC_CTX)].map(m => m[3]!)
}

function stripTs(p: string): string {
  return p.replace(/\.ts$/, '')
}

/** Keep the original spec's index style: `./db` stays dir-style, `./db/index` stays explicit. */
function indexStyle(spec: string, resolvedOld: string, target: string): string {
  const viaIndex = resolvedOld.endsWith('/index.ts') && !/(^|\/)index(\.ts)?$/.test(spec)
  return viaIndex ? target.replace(/\/index$/, '') : target
}

export interface Plan {
  moves: Map<string, string>
  dirMoves: Map<string, string>
  writes: Map<string, string> // new path (or unchanged path for outside files) -> new content
  edits: number
  errors: string[]
}

export function plan(): Plan {
  const closure = coreClosure().files.filter(f => !f.startsWith('packages/'))
  const moves = new Map<string, string>(closure.map(f => [f, newPathFor(f)]))
  const errors: string[] = []

  // Colocated tests.
  const dirs = new Set(closure.map(f => dirname(f)))
  const dirMoves = new Map<string, string>()
  for (const d of [...dirs].sort()) {
    const tests = readdirSync(join(ROOT, d)).filter(n => n.endsWith('.test.ts')).map(n => posix.join(d, n))
    const fixtureUsers: { test: string, moves: boolean }[] = []
    for (const t of tests) {
      const src = readFileSync(join(ROOT, t), 'utf8')
      const local = specsIn(src).filter(isLocalSpec).map(s => resolveSpec(t, s))
      const moving = local.length > 0 && local.every(r => r !== null && moves.has(r))
      if (moving) moves.set(t, newPathFor(t))
      if (src.includes('__fixtures__')) fixtureUsers.push({ test: t, moves: moving })
    }
    const fx = posix.join(d, '__fixtures__')
    if (existsSync(join(ROOT, fx)) && fixtureUsers.length && fixtureUsers.every(u => u.moves)) {
      dirMoves.set(fx, newPathFor(fx))
    }
  }

  const writes = new Map<string, string>()
  let edits = 0
  const consumers = execFileSync('git', ['ls-files', ...CONSUMER_ROOTS], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(f => CODE_EXT.test(f))
  for (const file of new Set([...consumers, ...moves.keys()])) {
    const src = readFileSync(join(ROOT, file), 'utf8')
    const newFile = moves.get(file)
    const out = src.replace(SPEC_CTX, (whole, ctx: string, q: string, spec: string) => {
      if (!isLocalSpec(spec)) return whole
      const r = resolveSpec(file, spec)
      if (!r) return whole
      // Files already in core (config.ts) count as moved-in-place, so moved files reach them relatively.
      const target = moves.get(r) ?? (newFile && r.startsWith(CORE_SRC + '/') ? r : undefined)
      if (!target) {
        if (newFile && !r.startsWith('packages/')) errors.push(`${file}: '${spec}' -> ${r} does not move`)
        return whole
      }
      let next: string
      if (newFile) {
        next = stripTs(posix.relative(posix.dirname(newFile), target))
        if (!next.startsWith('.')) next = './' + next
      } else {
        next = '@mymind/core/' + stripTs(posix.relative(CORE_SRC, target))
      }
      next = indexStyle(spec, r, next)
      if (next === spec) return whole
      edits++
      return `${ctx}${q}${next}${q}`
    })
    if (newFile || out !== src) writes.set(newFile ?? file, out)
  }
  return { moves, dirMoves, writes, edits, errors }
}

const isMain = process.argv[1] && relative(process.argv[1], new URL(import.meta.url).pathname) === ''
if (isMain) {
  const p = plan()
  if (p.errors.length) {
    console.error(`refusing: ${p.errors.length} moved-file imports reach non-moving code:`)
    for (const e of p.errors) console.error('  ' + e)
    process.exit(1)
  }
  const tests = [...p.moves.keys()].filter(f => f.endsWith('.test.ts')).length
  const outside = [...p.writes.keys()].filter(f => !f.startsWith(CORE_SRC)).length
  console.log(`moves: ${p.moves.size} files (${p.moves.size - tests} closure + ${tests} tests), ${p.dirMoves.size} dirs`)
  console.log(`rewrites: ${p.edits} specifiers; ${outside} outside files edited`)
  if (process.argv.includes('--dry-run')) {
    for (const [a, b] of p.moves) console.log(`mv ${a} -> ${b}`)
    for (const [a, b] of p.dirMoves) console.log(`mv ${a}/ -> ${b}/`)
    for (const f of [...p.writes.keys()].filter(f => !f.startsWith(CORE_SRC))) console.log(`edit ${f}`)
    process.exit(0)
  }
  for (const [a, b] of [...p.moves, ...p.dirMoves]) {
    mkdirSync(join(ROOT, dirname(b)), { recursive: true })
    execFileSync('git', ['mv', a, b], { cwd: ROOT })
  }
  for (const [f, content] of p.writes) writeFileSync(join(ROOT, f), content)
  console.log('done')
}
