// The runner's default publisher (cycle 81, spec §3.1): every hub frame of a run goes to the
// Postgres run-event log, where the web's voice sockets read it (lib/bus/relay.ts). Text/reasoning
// deltas are coalesced ≈50ms by the writer; any other frame is written on the next macrotask.
// No audio: TTS runs in the web (spec §4), so the runner never publishes binary frames.
import { createRunEventWriter, type HubFrame, type RunEventWriterOptions } from '../../bus/events'
import type { RunPublisher } from './stream'

export function busPublisher(runId: string, conversationId: string, opts?: RunEventWriterOptions): RunPublisher {
  const writer = createRunEventWriter(runId, conversationId, opts)
  return {
    beginRun() {},
    publish(_conversationId, data, o = {}) {
      let frame: HubFrame
      try { frame = JSON.parse(data) as HubFrame } catch { return }
      writer.emit(frame, o.only ?? null)
    },
    // Flush + close: resolves once every frame is committed (rejects if a batch was lost).
    endRun: () => writer.close()
  }
}
