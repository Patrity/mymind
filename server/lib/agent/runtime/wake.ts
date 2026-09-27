// The single entry point for anything that is not Tony typing. Heartbeat, cron and event
// triggers (cycle 74) are new CALLERS of this; nothing else may enqueue a headless run.
import { enqueue } from './queue'
import type { SessionKey } from './types'

export interface WakeRequest { reason: string; prompt: string; sessionKey?: SessionKey; model?: string | null }

export async function wake(req: WakeRequest, deps: { kick?: boolean } = {}): Promise<{ runId: string; conversationId: string }> {
  const reason = req.reason.trim(); const prompt = req.prompt.trim()
  if (!reason || !/^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(reason)) throw new Error('wake: reason must be a short slug')
  if (!prompt) throw new Error('wake: prompt is required')
  const r = await enqueue({
    sessionKey: req.sessionKey ?? 'main', trigger: 'wake', profile: 'headless', wakeReason: reason,
    modelDefId: req.model ?? null, input: { text: prompt, modality: 'text' }
  }, { kick: deps.kick })
  return { runId: r.runId, conversationId: r.conversationId }
}
