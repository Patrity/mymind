// The single entry point for anything that is not Tony typing. Heartbeat, cron and event
// triggers (cycle 74) are new CALLERS of this; nothing else may enqueue a headless run.
import { enqueue } from './queue'
import type { SessionKey } from './types'

export interface WakeRequest {
  reason: string; prompt: string; sessionKey?: SessionKey; model?: string | null
  /** The job this wake fires for (cycle 74): stamped on agent_runs.job_id. */
  jobId?: string | null
  /** History depth for the run (RunInput.context); omitted = full. */
  context?: 'light' | 'full'
  /** Cycle 78: toolsets a job declared; loaded at run start. */
  toolsets?: string[]
}

export async function wake(req: WakeRequest, deps: { kick?: boolean } = {}): Promise<{ runId: string; conversationId: string }> {
  const reason = req.reason.trim(); const prompt = req.prompt.trim()
  // Up to 80 chars: a job fire's reason is 'job:' + a slug of up to 64 (cycle 74).
  if (!reason || !/^[a-z0-9][a-z0-9:_-]{0,79}$/i.test(reason)) throw new Error('wake: reason must be a short slug')
  if (!prompt) throw new Error('wake: prompt is required')
  const r = await enqueue({
    sessionKey: req.sessionKey ?? 'main', trigger: 'wake', profile: 'headless', wakeReason: reason,
    modelDefId: req.model ?? null, jobId: req.jobId ?? null,
    input: { text: prompt, modality: 'text', ...(req.context ? { context: req.context } : {}), ...(req.toolsets?.length ? { toolsets: req.toolsets } : {}) }
  }, { kick: deps.kick })
  return { runId: r.runId, conversationId: r.conversationId }
}
