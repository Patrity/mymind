import { setExecutionMode } from '@mymind/core/lib/agent/runtime/queue'
import { startLiveBridge } from '@mymind/core/lib/bus/live'

// Cycle 81: the web process NEVER executes agent runs — apps/worker is the only executor (boot
// recovery, the 5s tick, jobs, the agent scheduled tasks). Here: enqueue()'s kick becomes a `kick`
// command to the worker (remote execution mode), and the live bridge carries the worker's
// publishChange/publishActivity to this process's SSE listeners. A run's frames reach the voice
// sockets over the run-event log (lib/bus/relay.ts, subscribed per socket in server/api/voice/ws.ts).
export default defineNitroPlugin((nitro) => {
  if (import.meta.prerender) return
  setExecutionMode('remote')
  const stopBridge = startLiveBridge('web')
  nitro.hooks.hook('close', () => stopBridge())
})
