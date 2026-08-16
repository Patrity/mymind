import { defineConfig } from 'vitest/config'

// Runs DB-backed tests (*.db.test.ts) that need a real Postgres. These are excluded from the
// base vitest.config.ts (and therefore from `pnpm test` / the CI gate, which has no database
// service) — this config is the only runner that picks them up, via `pnpm test:db` locally.
export default defineConfig({
  test: {
    // Every file here mutates ONE real shared Postgres (Tony's dev DB), and until Task 9's
    // sweepUntriaged (test/triage-sweeper.db.test.ts) every fixture was scoped to a doc ID
    // the test itself created — cross-file collisions couldn't happen even with files running
    // in parallel worker processes. sweepUntriaged is different: its whole job is to scan
    // every live, untriaged /input/* row with no per-caller scoping (that's the point of a
    // backstop sweep). Running it concurrently with e.g. triage-idempotency.db.test.ts — which
    // creates a fresh /input doc and expects to be the one to triageCapture() it — let the
    // sweeper occasionally claim that doc first, flipping their `skipped`/`queued` assertions
    // out from under them (observed directly: a `pnpm test:db` run failed two of their
    // assertions with the sweeper's stub outcome instead of theirs). Serializing file execution
    // removes the race at its root; the whole suite still runs in ~1.5s, so the cost is nil.
    fileParallelism: false,
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
