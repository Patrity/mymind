import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Minimal config: keep vitest's default test discovery but also exclude
// `.claude/**` so leftover agent git-worktrees under `.claude/worktrees/*`
// (which carry their own duplicate `test/` dirs) don't get double-discovered
// and inflate/confuse the suite. Mirrors vitest's default exclude list + that path.
export default defineConfig({
  resolve: {
    // Nuxt configures these aliases (`~~`/`@@` -> rootDir, `~`/`@` -> srcDir='app') for its
    // own Vite build, but plain `vitest run` never boots Nuxt, so a unit test that imports a
    // module which does a *value*-level `~~/shared/...` import (not `import type`, which Vite
    // erases before resolution) fails with "Cannot find module" — type-only shared imports
    // happened to be the only kind exercised under direct unit tests before folders.ts.
    alias: {
      '~~': fileURLToPath(new URL('.', import.meta.url)),
      '@@': fileURLToPath(new URL('.', import.meta.url)),
      '~': fileURLToPath(new URL('./app', import.meta.url)),
      '@': fileURLToPath(new URL('./app', import.meta.url))
    }
  },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      '**/.claude/**',
      // DB-backed tests (*.db.test.ts) need a real Postgres. CI has no database service and
      // `deploy` needs `test`, so they run via `pnpm test:db` locally, never in the CI gate.
      '**/*.db.test.ts'
    ]
  }
})
