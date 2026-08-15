import { defineConfig } from 'vitest/config'

// Minimal config: keep vitest's default test discovery but also exclude
// `.claude/**` so leftover agent git-worktrees under `.claude/worktrees/*`
// (which carry their own duplicate `test/` dirs) don't get double-discovered
// and inflate/confuse the suite. Mirrors vitest's default exclude list + that path.
export default defineConfig({
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
    ],
    testTimeout: 10000
  }
})
