// server/lib/agent/runtime/aborts.ts
// runId → AbortController. An abort that arrives before the run registers (Stop pressed while
// the run is still queued/claiming) is remembered and applied on registration.
const controllers = new Map<string, AbortController>()
const preAborted = new Set<string>()

export function registerAbort(runId: string): AbortController {
  const ac = new AbortController()
  controllers.set(runId, ac)
  if (preAborted.delete(runId)) ac.abort()
  return ac
}
export function abortRun(runId: string): boolean {
  const ac = controllers.get(runId)
  if (ac) {
    ac.abort()
    return true
  }
  preAborted.add(runId)
  return false
}
export function releaseAbort(runId: string): void {
  controllers.delete(runId)
  preAborted.delete(runId)
}
