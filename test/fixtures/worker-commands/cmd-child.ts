// The "worker" of test/worker-commands.db.test.ts (cycle 81 Task 4): a separate node process (plain
// tsx, no vitest, no Nuxt — as apps/worker runs core) that answers worker commands with the REAL
// handlers apps/worker uses (commandHandlers + coreCommandDeps; `kick` is a no-op so nothing pumps
// the shared dev DB), and executes runs the parent hands it through the queue's own execute path.
// stdin, one command per line → stdout:
//   run <runId> <agent>   → executes the (parent-inserted, 'running') run here   → RUNDONE <runId> <status>
//   away                  → AWAY <isAway()>
//   prime-ai | ai         → plants a sentinel in the ai-registry cache | AI <sentinel|db>
//   undo-ttl <ms>         → shortens the undo TTL                                 → OK
// The `task` agent prints UNDO <token> <taskId> when its create_task call returns.
import { createInterface } from 'node:readline'
import { initCore } from '@mymind/core/config'
import { fromEnv } from '@mymind/core/config-env'

initCore(fromEnv(process.env))
const [
  { useDb }, { agentRuns }, { eq }, queue, { runTurn }, { BOOT_ID }, commands, listen,
  { buildAiTools }, { agentTools }, { createNoncePinStore }, presence, registry, undo,
  { commandHandlers }, { coreCommandDeps }
] = await Promise.all([
  import('@mymind/core/db'), import('@mymind/core/db/schema'), import('drizzle-orm'),
  import('@mymind/core/lib/agent/runtime/queue'), import('@mymind/core/lib/agent/runtime/runner'),
  import('@mymind/core/lib/agent/runtime/runs'), import('@mymind/core/lib/bus/commands'), import('@mymind/core/lib/bus/listen'),
  import('@mymind/core/lib/agent/ai-tools'), import('@mymind/core/lib/agent/tools'), import('@mymind/core/lib/google/approval-pins'),
  import('@mymind/core/lib/channels/presence'), import('@mymind/core/lib/ai/registry/store'), import('@mymind/core/lib/agent/undo'),
  import('../../../apps/worker/src/worker'), import('../../../apps/worker/src/command-deps')
])
type AgentTool = import('@mymind/core/lib/agent/types').AgentTool
type Ctx = { signal: AbortSignal; requestApproval?: (r: never) => Promise<{ approved: boolean }> }

const out = (line: string) => process.stdout.write(`${line}\n`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// A gmail_send-shaped dangerous tool: its card pins a content fingerprint to THIS approval's nonce
// (describeApproval), and the handler acts only if its own ctx.approvalNonce finds that pin — the
// cycle-79 binding, exercised with the decision arriving from another process.
const pins = createNoncePinStore<string>()
const fakeSend: AgentTool = {
  name: 'fake_send', description: 'test', kind: 'create', schema: {}, dangerous: true,
  describeApproval: async (_input, meta) => {
    pins.remember(meta?.approvalNonce, 'draft-v1')
    return { tool: 'fake_send', title: 'Send this?', command: 'send draft-v1', proposedPattern: '', logSummary: 'fake_send: draft-v1' }
  },
  handler: async (_input, ctx) => ({ result: { sent: pins.take(ctx.approvalNonce) === 'draft-v1' }, summary: 'sent' })
}

async function callTool(set: ReturnType<typeof buildAiTools>, name: string, input: Record<string, unknown>): Promise<unknown> {
  const t = set[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }
  return t.execute(input, { toolCallId: `call-${name}`, messages: [] })
}

const agents: Record<string, (m: unknown, ctx: Ctx) => AsyncGenerator<unknown>> = {
  async* approval(_m, ctx) {
    const set = buildAiTools([fakeSend], { signal: ctx.signal, requestApproval: ctx.requestApproval as never, onEvent: () => {} })
    const result = await callTool(set, 'fake_send', {})
    yield { type: 'text-delta', text: `RESULT:${JSON.stringify(result)}` }
    yield { type: 'done' }
  },
  // Streams until aborted, then unwinds SLOWLY (like a real turn mid-step), so a /clear that did not
  // wait for the abort's answer would write its epoch before the runner's rescue lands.
  async* slow(_m, ctx) {
    for (let i = 0; i < 300; i++) {
      if (ctx.signal.aborted) { await sleep(600); return }
      yield { type: 'text-delta', text: `word${i} ` }
      await sleep(100)
    }
    yield { type: 'done' }
  },
  async* task(_m, ctx) {
    let token: string | undefined
    const set = buildAiTools(agentTools.filter(t => t.name === 'create_task'), {
      signal: ctx.signal, onEvent: (e) => { if (e.type === 'tool-result') token = e.undoToken }
    })
    const task = await callTool(set, 'create_task', { title: `WORKERCMD-TEST task ${Date.now()}` }) as { id: string }
    out(`UNDO ${token} ${task.id}`)
    yield { type: 'text-delta', text: 'Added it.' }
    yield { type: 'done' }
  }
}
const noAssemble = async () => ({ context: '', usedMemoryIds: [], used: 0, droppedTurns: 0 })

const deps = await coreCommandDeps()
commands.handleCommands(commandHandlers({ ...deps, kick: () => {} }), { pollMs: 500 })
await listen.listenReady()

const SENTINEL = { version: 1 as const, providers: [{ id: 'SENTINEL', name: 'sentinel', kind: 'openai-compatible' as const, baseURL: null, apiKeyEnc: null }], models: [], assignments: {} as never }

createInterface({ input: process.stdin }).on('line', (line) => {
  const [cmd, a, b] = line.trim().split(/\s+/)
  void (async () => {
    if (cmd === 'run') {
      const [run] = await useDb().update(agentRuns).set({ owner: BOOT_ID }).where(eq(agentRuns.id, a!)).returning()
      await queue._executeClaimedForTests(run!, r => runTurn(r, { runAgent: agents[b!] as never, assemble: noAssemble as never, unavailableToolsets: async () => [] }))
      const [done] = await useDb().select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, a!))
      out(`RUNDONE ${a} ${done?.status}`)
    } else if (cmd === 'away') out(`AWAY ${await presence.isAway()}`)
    else if (cmd === 'prime-ai') { registry._setConfigCacheForTests(SENTINEL as never); out('OK') }
    else if (cmd === 'ai') out(`AI ${(await registry.loadConfig()).providers.some(p => p.id === 'SENTINEL') ? 'sentinel' : 'db'}`)
    else if (cmd === 'undo-ttl') { undo._setUndoTtlForTests(Number(a) > 0 ? Number(a) : null); out('OK') }
  })().catch((err) => { out(`ERR ${(err as Error).message}`) })
})
out(`READY ${process.pid}`)
