// Stages a SELF-CONTAINED worker release: `node apps/worker/stage.mjs <outDir>` (after `build`).
//
//   <outDir>/dist/worker.mjs(.map)   the esbuild bundle
//   <outDir>/node_modules/<ext>       the external packages (build.mjs EXTERNAL) …
//   <outDir>/node_modules/.pnpm/…     … and their whole dependency closure, copied from the
//                                     workspace's pnpm store layout with relative symlinks intact
//
// Why (Task 2 review I1): CD's sync deletes the tracked tree (apps/ included) and `pnpm install`
// rewrites node_modules minutes before the worker restarts. A release dir outside both — /opt/mymind/
// .worker, preserved by the sync — keeps the running worker's lazy imports (pdf-to-img) and a
// crash-restart working through the whole build window. deploy/worker-release.sh stages into
// .worker-next and swaps it in just before `systemctl restart mymind-worker`.
//
// The closure walk mirrors pnpm's layout: a package lives at .pnpm/<entry>/node_modules/<name>, and
// its dependencies are symlinks next to it pointing at sibling entries (../../<dep-entry>/…). Copying
// every reachable entry with symlinks preserved gives a tree Node resolves exactly like the original.
// Finally every external is imported FROM the staged bundle's location, so a missing file fails the
// stage (and the deploy), never the running worker.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EXTERNAL_PACKAGES } from './externals.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(process.argv[2] ?? '')
if (!process.argv[2]) { console.error('usage: node apps/worker/stage.mjs <outDir>'); process.exit(2) }
const bundle = join(here, 'dist/worker.mjs')
if (!existsSync(bundle)) { console.error(`[worker stage] ${bundle} missing — run \`pnpm --filter worker build\` first`); process.exit(1) }

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'dist'), { recursive: true })
for (const f of ['worker.mjs', 'worker.mjs.map']) if (existsSync(join(here, 'dist', f))) cpSync(join(here, 'dist', f), join(out, 'dist', f))

const pnpmStore = (() => {
  // The workspace's virtual store: <root>/node_modules/.pnpm (each external's realpath lives in it).
  const real = realpathSync(join(here, 'node_modules', EXTERNAL_PACKAGES[0]))
  const i = real.indexOf(`${sep}node_modules${sep}.pnpm${sep}`)
  if (i < 0) throw new Error(`not a pnpm layout: ${real}`)
  return real.slice(0, i + `${sep}node_modules${sep}.pnpm`.length)
})()

/** The .pnpm entry name a real package path belongs to. */
const entryOf = (real) => relative(pnpmStore, real).split(sep)[0]

const entries = new Set()
const queue = []
const addEntry = (entry) => { if (!entries.has(entry)) { entries.add(entry); queue.push(entry) } }

for (const name of EXTERNAL_PACKAGES) addEntry(entryOf(realpathSync(join(here, 'node_modules', name))))
while (queue.length) {
  const entry = queue.pop()
  const nm = join(pnpmStore, entry, 'node_modules')
  const scan = (dir) => {
    for (const d of readdirSync(dir)) {
      const p = join(dir, d)
      if (d.startsWith('@') && lstatSync(p).isDirectory() && !lstatSync(p).isSymbolicLink()) { scan(p); continue }
      if (lstatSync(p).isSymbolicLink()) {
        const target = resolve(dirname(p), readlinkSync(p))
        if (target.startsWith(pnpmStore + sep)) addEntry(entryOf(target))
      }
    }
  }
  scan(nm)
}

const outStore = join(out, 'node_modules', '.pnpm')
mkdirSync(outStore, { recursive: true })
for (const entry of entries) cpSync(join(pnpmStore, entry), join(outStore, entry), { recursive: true, verbatimSymlinks: true })

// Top-level links, exactly like the workspace's: node_modules/<name> → .pnpm/<entry>/node_modules/<name>
for (const name of EXTERNAL_PACKAGES) {
  const real = realpathSync(join(here, 'node_modules', name))
  const link = join(out, 'node_modules', name)
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(relative(dirname(link), join(outStore, relative(pnpmStore, real))), link)
}
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'mymind-worker-release', private: true, type: 'module' }, null, 2) + '\n')

// Prove every external resolves and loads from the staged bundle's own location.
const probe = join(out, 'dist', '.verify-externals.mjs')
writeFileSync(probe, EXTERNAL_PACKAGES.map(n => `await import(${JSON.stringify(n)})`).join('\n') + '\nconsole.log("ok")\n')
try {
  execFileSync(process.execPath, [probe], { stdio: ['ignore', 'pipe', 'inherit'] })
} finally { rmSync(probe, { force: true }) }

const size = execFileSync('du', ['-sh', out]).toString().split('\t')[0]
console.log(`[worker stage] ${out}: bundle + ${EXTERNAL_PACKAGES.length} externals (${entries.size} store entries, ${size}) — all externals load`)
