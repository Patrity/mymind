import { defineConfig } from 'vitest/config'

// Runs DB-backed tests (*.db.test.ts) that need a real Postgres. These are excluded from the
// base vitest.config.ts (and therefore from `pnpm test` / the CI gate, which has no database
// service) — this config is the only runner that picks them up, via `pnpm test:db` locally.
export default defineConfig({
  test: {
    include: ['**/*.db.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      '**/.claude/**'
    ]
  }
})
