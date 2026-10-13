// Cycle 85 (spec §3.3): `pnpm eval <suite> [--case <slug>]… [--n <runs>] [--model <modelDefId>] [--no-wait] [--local]`
//
// Enqueues an eval run (the worker job `eval:run-suite` — the worker in THIS bus namespace runs it,
// so it must be up: `pnpm dev` locally, mymind-worker in prod) and tails its progress until it ends.
// Ctrl-C stops tailing only; the run keeps going in the worker (`--cancel <runId>` cancels one).
// `--local` runs the job in THIS process instead (no worker needed — dev); Ctrl-C then cancels it.
// Built-in suites (evals/*.json) are seeded first, so `pnpm eval bridget-core` works on a fresh DB.
// Exit code: 0 when the run finished (`done`), 1 otherwise.
import { initCore } from '@mymind/core/config'
import { fromEnv } from '@mymind/core/config-env'

initCore(fromEnv(process.env, { dev: process.env.NODE_ENV !== 'production' }))

const { eq, asc } = await import('drizzle-orm')
const { useDb } = await import('@mymind/core/db')
const { evalSuites, evalRuns, evalResults, evalCases } = await import('@mymind/core/db/schema')
const { seedBuiltinSuites } = await import('@mymind/core/lib/eval/suites')
const { enqueueEvalRun, cancelEvalRun, startEvalRun, _evalRunSettled, EvalRunError } = await import('@mymind/core/lib/eval/runs')
const { busNs } = await import('@mymind/core/lib/bus/ns')
const { EVAL_RUN_TERMINAL } = await import('@mymind/core/shared/types/eval')
type Summary = import('@mymind/core/shared/types/eval').EvalRunSummary

function usage(msg?: string): never {
  if (msg) console.error(`eval: ${msg}`)
  console.error('usage: pnpm eval <suite> [--case <slug>]… [--n <runs>] [--model <modelDefId>] [--no-wait] [--local]\n       pnpm eval --cancel <runId>')
  process.exit(2)
}

const argv = process.argv.slice(2)
let suiteName: string | null = null
const cases: string[] = []
let n: number | undefined
let model: string | undefined
let wait = true
let cancel: string | null = null
let local = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!
  const val = () => argv[++i] ?? usage(`${a} needs a value`)
  if (a === '--case') cases.push(...val().split(',').map(s => s.trim()).filter(Boolean))
  else if (a === '--n') { n = Number(val()); if (!Number.isInteger(n) || n < 1) usage('--n must be a positive whole number') }
  else if (a === '--model') model = val()
  else if (a === '--no-wait') wait = false
  else if (a === '--local') local = true
  else if (a === '--cancel') cancel = val()
  else if (a.startsWith('--')) usage(`unknown option ${a}`)
  else if (!suiteName) suiteName = a
  else usage(`unexpected argument ${a}`)
}

const db = useDb()
if (cancel) {
  console.log((await cancelEvalRun(cancel)) ? `cancelled ${cancel}` : `${cancel} is not queued or running`)
  process.exit(0)
}
if (!suiteName) usage()

for (const s of await seedBuiltinSuites()) if (s.error) console.warn(`seeding ${s.file} failed: ${s.error}`)
const [suite] = await db.select().from(evalSuites).where(eq(evalSuites.name, suiteName))
if (!suite) {
  const names = (await db.select({ name: evalSuites.name }).from(evalSuites).orderBy(asc(evalSuites.name))).map(r => r.name)
  usage(`no suite named "${suiteName}" (have: ${names.join(', ') || 'none'})`)
}

let run
try {
  run = await enqueueEvalRun(suite.id, { ...(cases.length ? { cases } : {}), ...(n ? { n } : {}), ...(model ? { model } : {}) }, local ? { send: async () => {} } : {})
} catch (err) {
  if (err instanceof EvalRunError) usage(err.message)
  throw err
}
console.log(`eval run ${run.id} — suite ${suite.name} (${local ? 'in this process' : `bus ns ${busNs()}`})`)
if (local) {
  if (!(await startEvalRun(run.id)).started) { console.error('could not claim the run'); process.exit(1) }
} else if (!wait) process.exit(0)

process.on('SIGINT', () => {
  if (local) {
    console.log('\ncancelling (the attempt in flight stops, its world is cleaned up)…')
    void cancelEvalRun(run.id).then(() => _evalRunSettled(run.id)).finally(() => process.exit(130))
    return
  }
  console.log(`\nstopped tailing; the run continues in the worker (cancel: pnpm eval --cancel ${run.id})`)
  process.exit(130)
})

const pct = (x: number | null | undefined) => x === null || x === undefined ? '—' : `${(x * 100).toFixed(0)}%`
const sec = (ms: number | null | undefined) => `${((ms ?? 0) / 1000).toFixed(1)}s`
// By id, not by created_at: a JS Date drops Postgres's microseconds, so `> last` would re-select rows.
const printed = new Set<string>()
const started = Date.now()
let warned = false
for (;;) {
  const [row] = await db.select().from(evalRuns).where(eq(evalRuns.id, run.id))
  if (!row) { console.error('the run disappeared'); process.exit(1) }
  const rows = await db.select({ id: evalResults.id, slug: evalCases.slug, attempt: evalResults.attempt, score: evalResults.score, passed: evalResults.passed, error: evalResults.error, durationMs: evalResults.durationMs, createdAt: evalResults.createdAt })
    .from(evalResults).innerJoin(evalCases, eq(evalCases.id, evalResults.caseId))
    .where(eq(evalResults.runId, run.id)).orderBy(asc(evalResults.createdAt))
  const fresh = rows.filter(r => !printed.has(r.id))
  const planned = (row.summary as Summary | null)?.planned
  for (const r of fresh) {
    printed.add(r.id)
    console.log(`  ${r.passed ? 'PASS' : 'fail'}  ${r.slug} #${r.attempt}  score ${(r.score ?? 0).toFixed(2)}  ${sec(r.durationMs)}${r.error ? `  — ${r.error}` : ''}${planned ? `   [${printed.size}/${planned}]` : ''}`)
  }
  if (row.status === 'queued' && !warned && Date.now() - started > 30_000) {
    warned = true
    console.log(`  (still queued after 30 s — is a worker running in bus namespace ${busNs()}?)`)
  }
  if (EVAL_RUN_TERMINAL.includes(row.status as never)) {
    const s = row.summary as Summary | null
    console.log(`\n${row.status.toUpperCase()}${row.error ? ` — ${row.error}` : ''}`)
    if (s) {
      console.log(`pass rate: overall ${pct(s.overall.passRate)} (${s.overall.passed}/${s.overall.cases}) · non-holdout ${pct(s.nonHoldout.passRate)} · holdout ${pct(s.holdout.passRate)}`)
      console.log(`mean score ${s.overall.meanScore?.toFixed(3) ?? '—'} · attempts ${s.attempts} (${s.failedAttempts} failed) · tokens ${s.tokens} · ${sec(s.durationMs)}`)
      for (const c of s.cases) console.log(`  ${c.passed ? 'PASS' : 'fail'}  ${c.slug}${c.holdout ? ' (holdout)' : ''}  mean ${c.meanScore?.toFixed(2) ?? '—'}${c.forbidden ? '  FORBIDDEN' : ''}${c.failedAttempts ? `  ${c.failedAttempts} failed` : ''}`)
    }
    console.log(`git ${row.gitSha ?? '—'} · model ${row.modelLabel ?? '—'} · prompt ${row.promptHash?.slice(0, 12) ?? '—'} · tools ${row.toolsHash?.slice(0, 12) ?? '—'}`)
    if (local) await _evalRunSettled(run.id) // its worlds are cleaned up before the process ends
    process.exit(row.status === 'done' ? 0 : 1)
  }
  await new Promise(r => setTimeout(r, 2_000))
}
