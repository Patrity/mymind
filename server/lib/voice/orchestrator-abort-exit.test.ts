// Characterization test for the ONE protocol fact the /agent composer has to compensate for:
//
//   `handleTurn` returns at orchestrator.ts's `if (deps.signal.aborted) return messages`
//   BEFORE it reaches `deps.emit({ type: 'state', state: 'idle' })`.
//
// So an ABORTED turn produces no terminal state event, and therefore ws.ts sends no
// `{type:'state', state:'idle'}` frame for it. Every client path that aborts a turn
// (`{type:'interrupt'}`, `{type:'new'}`, `{type:'load'}`) has to return itself to rest —
// `useVoice.restAfterAbort()`. Cycle 65 shipped `newConversation()`/`loadConversation()`
// without that, and the composer sat on "Stop generating" indefinitely (measured: still busy
// two minutes after the click), with no way to send in the new thread short of pressing Stop.
//
// This test is the regression net for that wedge: it pins the server half, so if anyone later
// makes the abort path emit a terminal state (the race-free fix, deferred), this test goes red
// and points at the UI compensation that can then be removed.
import { describe, it, expect } from 'vitest'
import { handleTurn, type VoiceEvent } from './orchestrator'
import type { AgentEvent } from '../agent/run'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

const preset: VoicePresetDTO = {
  id: 'p1', name: 'n', instruction: 'A calm man.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: null, refText: null, refDurationMs: null,
  maxSegmentChars: 200, calibratedRefKey: null, refSource: null, starredSeeds: [], isDefault: true
}

/**
 * Runs a turn whose agent stream yields `agentEvents`, optionally aborting the signal
 * partway through (`abortAfter` = index of the yielded event after which `ac.abort()` fires).
 * Aborting from INSIDE the generator is what really happens: the client's interrupt/new/load
 * frame lands while the model is mid-stream.
 */
async function run(agentEvents: AgentEvent[], abortAfter?: number) {
  const ac = new AbortController()
  const events: VoiceEvent[] = []
  const out = await handleTurn('what are my open tasks?', [], {
    tts: { async *synthesize() {} } as never, preset, signal: ac.signal, speak: false,
    emit: e => { events.push(e) },
    async *runAgent() {
      for (const [i, e] of agentEvents.entries()) {
        yield e
        if (abortAfter === i) ac.abort()
      }
    }
  })
  return { events, out, aborted: ac.signal.aborted }
}

const states = (events: VoiceEvent[]) =>
  events.filter(e => e.type === 'state').map(e => (e as Extract<VoiceEvent, { type: 'state' }>).state)

describe('handleTurn — the abort exit emits no terminal state', () => {
  it('a turn aborted mid-stream never emits state:idle', async () => {
    const { events, aborted } = await run([
      { type: 'text-delta', text: 'Checking your ' },
      { type: 'text-delta', text: 'tasks...' }
    ], 0)

    expect(aborted).toBe(true)
    // The whole point: the client is left in a non-terminal state by the protocol.
    expect(states(events)).not.toContain('idle')
    expect(events.find(e => e.type === 'state' && e.state === 'idle')).toBeUndefined()
  })

  it('the SAME turn, not aborted, DOES emit state:idle (the control)', async () => {
    const { events, aborted } = await run([
      { type: 'text-delta', text: 'Checking your ' },
      { type: 'text-delta', text: 'tasks...' }
    ])

    expect(aborted).toBe(false)
    expect(states(events)).toContain('idle')
  })

  it('an aborted turn returns the messages built so far, so ws.ts persists nothing new', async () => {
    const { out } = await run([{ type: 'text-delta', text: 'partial' }], 0)

    // Only the user message — the assistant turn is never appended on the abort path, which
    // is why an aborted turn is not persisted.
    expect(out.map(m => m.role)).toEqual(['user'])
  })

  it('a turn whose signal is aborted before any event still emits thinking but never idle', async () => {
    const { events } = await run([{ type: 'text-delta', text: 'x' }], 0)

    // `thinking` goes out at the top of handleTurn, before the model runs — so the client
    // is moved OUT of idle and never moved back. That asymmetry is the wedge.
    expect(states(events)[0]).toBe('thinking')
    expect(states(events)).not.toContain('idle')
  })
})
