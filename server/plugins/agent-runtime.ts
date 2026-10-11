import { coreConfig } from '@mymind/core/config'
import { bootAgentRuntime } from '@mymind/core/lib/agent/runtime/boot'
import { setExecutionMode, startWorker, stopWorker } from '@mymind/core/lib/agent/runtime/queue'
import { startAgentSchedule } from '@mymind/core/lib/agent/scheduled'
import { startLiveBridge } from '@mymind/core/lib/bus/live'

// Cycle 81: who executes agent runs is AGENT_EXECUTOR (CoreConfig.agentExecutor, read by this web
// process and by apps/worker from the same env — they always agree).
//  - 'web' (default until Task 3): this process executes, exactly as before — boot recovery, the 5s
//    pump/tick and the agent scheduled tasks (moved out of Nitro scheduledTasks into core's
//    startAgentSchedule, so the worker can run the same ones). The worker process idles.
//  - 'worker': this process NEVER claims a run. enqueue()'s kick becomes a `kick` command to the
//    worker, and the live bridge carries the worker's publishChange/publishActivity to this
//    process's SSE listeners. (Streaming frames still ride the in-process hub until Task 3, so a
//    chat turn's live text does not reach the socket in this mode yet.)
export default defineNitroPlugin(async (nitro) => {
  if (import.meta.prerender) return
  if (coreConfig().agentExecutor === 'worker') {
    setExecutionMode('remote')
    const stopBridge = startLiveBridge('web')
    nitro.hooks.hook('close', () => stopBridge())
    console.info('[runtime] AGENT_EXECUTOR=worker — agent runs execute in apps/worker')
    return
  }
  await bootAgentRuntime()
  startWorker()
  const stopSchedule = startAgentSchedule()
  nitro.hooks.hook('close', () => { stopWorker(); stopSchedule() })
})
