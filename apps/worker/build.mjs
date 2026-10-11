// Bundles the worker (src/main.ts + the @mymind/core source it reaches) into dist/worker.mjs.
// `pnpm --filter worker build`. Pure-JS dependencies are bundled; packages with native addons,
// runtime-resolved files or optional native peers stay EXTERNAL and are resolved at runtime from
// apps/worker/node_modules (each one is a dependency in package.json, same range as core's):
//   pg            — optional `pg-native` require; keep the real driver
//   sharp         — native addon (libvips)
//   pdf-to-img    — pdfjs-dist worker + canvas resolved from disk at runtime
//   isomorphic-dompurify — jsdom: require.resolve()s its own files and optional `canvas`
//   better-auth   — its kysely adapter statically imports sqlite dialects written against another
//                   kysely version (esbuild rejects the missing exports); Node resolves it as a package at runtime
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

export const EXTERNAL = ['pg', 'pg-native', 'sharp', 'pdf-to-img', 'isomorphic-dompurify', 'better-auth', 'better-auth/*']

const result = await build({
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(here, 'dist/worker.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: 'linked',
  external: EXTERNAL,
  // The bundle is never a dev host (see src/env.ts) — the worker's import.meta.dev.
  define: { __MYMIND_WORKER_DEV__: 'false' },
  // CJS dependencies bundled into ESM still call require()/__dirname: give them real ones.
  banner: {
    js: [
      "import { createRequire as __mmCreateRequire } from 'node:module';",
      "import { fileURLToPath as __mmFileURLToPath } from 'node:url';",
      "import { dirname as __mmDirname } from 'node:path';",
      'const require = __mmCreateRequire(import.meta.url);',
      'const __filename = __mmFileURLToPath(import.meta.url);',
      'const __dirname = __mmDirname(__filename);'
    ].join('\n')
  },
  metafile: true,
  logLevel: 'warning'
})

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0)
console.log(`[worker build] dist/worker.mjs — ${(bytes / 1024 / 1024).toFixed(1)} MB (incl. sourcemap), external: ${EXTERNAL.join(', ')}`)
