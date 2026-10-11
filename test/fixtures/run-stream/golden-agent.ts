// The fake model of the run-stream golden test (test/agent-stream-bus.db.test.ts): the SAME turn —
// reasoning, text, a tool call with its result, more text — driven in-process (StreamHub capture)
// and in a worker child process (run-child.ts, frames over the bus). `delayMs` paces it so a
// subscriber can join mid-run.
export function goldenAgent(delayMs = 0) {
  const pause = () => (delayMs ? new Promise(r => setTimeout(r, delayMs)) : Promise.resolve())
  return async function* (_m: unknown, ctx: { signal: AbortSignal }) {
    const steps: Array<Record<string, unknown>> = [
      { type: 'reasoning-delta', text: 'Look up ' },
      { type: 'reasoning-delta', text: 'the tasks.' },
      { type: 'text-delta', text: 'Let me ' },
      { type: 'text-delta', text: 'check. ' },
      { type: 'tool-start', name: 'search_tasks', args: { q: 'open' }, callId: 'call-1' },
      { type: 'tool-result', name: 'search_tasks', summary: 'listed tasks (2)', callId: 'call-1', args: { q: 'open' }, result: { tasks: ['a', 'b'] }, kind: 'read' },
      { type: 'text-delta', text: 'You have ' },
      { type: 'text-delta', text: 'two ' },
      { type: 'text-delta', text: 'open ' },
      { type: 'text-delta', text: 'tasks.' },
      { type: 'usage', inputTokens: 10, outputTokens: 7, totalTokens: 17 }
    ]
    for (const s of steps) {
      await pause()
      if (ctx.signal.aborted) return
      yield s as never
    }
    yield { type: 'done' } as never
  }
}

export const noAssemble = async () => ({ context: '', usedMemoryIds: [], used: 0, droppedTurns: 0 })
