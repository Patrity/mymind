import { defineConfig } from 'vitest/config'

// Files that only pass against Tony's populated dev DB (+ the AI rig): they call the real embedding /
// reasoning models (the ai_config registry row lives in the DB — an empty CI database has none, so
// every call throws AiNotConfiguredError) or assert on dev-only rows (seeded jobs, image rows, settings
// keys). CI (`DB_TESTS_CI=1`, see .github/workflows/deploy.yml) skips exactly these; a plain local
// `pnpm test:db` still runs everything. When you make one of them hermetic, delete it from this list.
const NEEDS_DEV_DB_OR_RIG = [
  'agent-runner', 'enrich-conversations', 'eval-cleanup', 'eval-runner', 'eval-tenant', 'improvements-tool',
  'judge-sticky-taint', 'memory-applicability', 'memory-concerns', 'memory-doc-candidates',
  'memory-dup-shortcircuit', 'memory-resident', 'memory-search-contradicts', 'outcome-judge',
  'triage-actuators', 'triage-multi-destination', 'triage-retriage', 'workstream-pools'
].map(n => `**/${n}.db.test.ts`)

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
    // Cycle 80: routes legacy useRuntimeConfig/$fetch stubs to coreConfig()/ofetch — see the file.
    setupFiles: ['test/setup/core-bridge.ts'],
    include: ['**/*.db.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      '**/.claude/**',
      ...(process.env.DB_TESTS_CI === '1' ? NEEDS_DEV_DB_OR_RIG : [])
    ]
  }
})
