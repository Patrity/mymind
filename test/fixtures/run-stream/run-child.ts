// The "worker" of test/agent-stream-bus.db.test.ts: a separate node process (plain tsx, no vitest,
// no Nuxt — as apps/worker runs core) that executes one already-claimed agent run with the runner's
// DEFAULT publisher, i.e. its frames go to the Postgres run-event log.
//   node --import tsx/esm run-child.ts <runId> <delayMs>   → prints DONE <pid> when the turn returned
import { initCore } from '@mymind/core/config'
import { fromEnv } from '@mymind/core/config-env'

initCore(fromEnv(process.env))
const [runId, delay] = process.argv.slice(2)
const [{ useDb }, { agentRuns }, { eq }, { runTurn }, { goldenAgent, noAssemble }] = await Promise.all([
  import('@mymind/core/db'), import('@mymind/core/db/schema'), import('drizzle-orm'),
  import('@mymind/core/lib/agent/runtime/runner'), import('./golden-agent')
])
const [run] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, runId!)).limit(1)
if (!run) { console.error(`no run ${runId}`); process.exit(2) }
const out = await runTurn(run, { runAgent: goldenAgent(Number(delay)) as never, assemble: noAssemble as never, unavailableToolsets: async () => [] })
console.log(`DONE ${process.pid} ${out.status}`)
process.exit(0)
