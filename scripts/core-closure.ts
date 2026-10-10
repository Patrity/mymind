// Cycle 80: the import closure of the worker's code — the set of files that make up @mymind/core.
//
//   tsx scripts/core-closure.ts            print the closure (one path per line) + a per-dir summary
//   tsx scripts/core-closure.ts --check    exit 1 if the closure reaches a forbidden root/specifier
//
// Seeds: server/lib/{agent,google,channels,ai,auth} + server/db (every non-test .ts under them).
// Edges: static/dynamic/type imports and re-exports whose specifier is relative, `~~/`/`@@/`
// (repo root), `~/`/`@/` (app/), or `@mymind/core/<path>` (packages/core/src/<path>.ts).
// npm packages are not followed. `*.test.ts` files are never part of the closure (they are
// carried along by the codemod when they only import closure files — see codemod-core-imports.ts).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'))

export const SEEDS = [
  'server/lib/agent',
  'server/lib/google',
  'server/lib/channels',
  'server/lib/ai',
  'server/lib/auth',
  'server/db'
]

/** Core must never reach these (Global Constraints). */
export const FORBIDDEN_ROOTS = ['app/', 'server/api/', 'server/plugins/', 'server/middleware/', 'server/tasks/']
export const FORBIDDEN_SPECIFIERS = [/^#imports$/, /^nitropack(\/|$)/, /^nitro(\/|$)/, /^h3$/, /^#internal\//]

const SPEC_RE = [
  /\bfrom\s+(['"])([^'"\n]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  /^\s*import\s+(['"])([^'"\n]+)\1/gm,
  /^\s*export\s+\*\s+from\s+(['"])([^'"\n]+)\1/gm
]

/** Every module specifier in a source text (deduped, in no particular order). */
export function specifiers(src: string): string[] {
  const out = new Set<string>()
  for (const re of SPEC_RE) {
    re.lastIndex = 0
    for (const m of src.matchAll(re)) out.add(m[2]!)
  }
  return [...out]
}

function fileFor(base: string): string | null {
  for (const c of [base + '.ts', join(base, 'index.ts'), base]) {
    if (c.endsWith('.ts') && existsSync(join(ROOT, c)) && statSync(join(ROOT, c)).isFile()) return c
  }
  return null
}

/**
 * Resolve a specifier written in repo-relative file `from` to a repo-relative .ts path, or null
 * for npm packages / unresolvable specifiers. Also returns null for non-.ts targets.
 */
export function resolveSpec(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('~~/') || spec.startsWith('@@/')) base = spec.slice(3)
  else if (spec.startsWith('~/') || spec.startsWith('@/')) base = join('app', spec.slice(2))
  else if (spec.startsWith('@mymind/core/')) base = join('packages/core/src', spec.slice('@mymind/core/'.length))
  else if (spec.startsWith('.')) base = join(dirname(from), spec)
  else return null
  return fileFor(normalize(base))
}

/** True for specifiers that point into the repo (as opposed to npm packages / node: builtins). */
export function isLocalSpec(spec: string): boolean {
  return spec.startsWith('.') || /^(~~|@@|~|@)\//.test(spec) || spec.startsWith('@mymind/core/')
}

function walk(dir: string): string[] {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return []
  const out: string[] = []
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'migrations') continue
      out.push(...walk(p))
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

export interface Closure {
  files: string[]
  /** forbidden hits: "<file> -> <specifier or file>" */
  violations: string[]
}

/**
 * After the move (cycle 80) the seed dirs are gone: the closure is then seeded from core itself,
 * and anything it reaches outside packages/core/src is a violation too.
 */
export function coreClosure(seeds: string[] = SEEDS): Closure {
  const seen = new Set<string>()
  const violations: string[] = []
  let queue = seeds.flatMap(walk)
  const moved = queue.length === 0
  if (moved) queue = walk('packages/core/src')
  while (queue.length) {
    const f = queue.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    if (FORBIDDEN_ROOTS.some(r => f.startsWith(r))) violations.push(`(closure) ${f}`)
    else if (moved && !f.startsWith('packages/core/src/')) violations.push(`(outside core) ${f}`)
    const src = readFileSync(join(ROOT, f), 'utf8')
    for (const spec of specifiers(src)) {
      if (FORBIDDEN_SPECIFIERS.some(re => re.test(spec))) violations.push(`${f} -> ${spec}`)
      const r = resolveSpec(f, spec)
      if (r && !seen.has(r)) queue.push(r)
    }
  }
  return { files: [...seen].sort(), violations }
}

const isMain = process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === ''
if (isMain) {
  const { files, violations } = coreClosure()
  if (process.argv.includes('--check')) {
    if (violations.length) {
      console.error(`core closure reaches forbidden code (${violations.length}):`)
      for (const v of violations) console.error('  ' + v)
      process.exit(1)
    }
    console.log(`core closure OK: ${files.length} files, no forbidden roots/specifiers`)
  } else {
    for (const f of files) console.log(f)
    const byDir = new Map<string, number>()
    for (const f of files) {
      const k = f.split('/').slice(0, 3).join('/')
      byDir.set(k, (byDir.get(k) ?? 0) + 1)
    }
    console.error('--- summary')
    for (const [k, v] of [...byDir].sort()) console.error(`${String(v).padStart(4)} ${k}`)
    console.error(`total ${files.length}`)
  }
}
