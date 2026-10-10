import type { ActivityInsert } from '../../db/schema/activity-log'
import type { ActivitySeverity, ObservabilityConfig } from './types'
import { decryptSecret } from '../ai/registry/crypto'
import { sendResendEmail } from './email'
import { loadObsConfig } from './config'

const ORDER: Record<'warn' | 'error', number> = { warn: 1, error: 2 }

export function shouldNotify(cfg: ObservabilityConfig, severity: ActivitySeverity): boolean {
  const e = cfg.alerts.email
  if (!e.enabled || !e.recipient || !e.apiKeyEnc) return false
  if (severity !== 'warn' && severity !== 'error') return false
  return ORDER[severity] >= ORDER[e.minSeverity]
}

export function buildDigest(rows: ActivityInsert[]): { subject: string, text: string } {
  const subject = `[MyMind] ${rows.length} error${rows.length === 1 ? '' : 's'} logged`
  const text = rows.map((r) => {
    const msg = (r.error as { message?: string } | null)?.message ?? ''
    return `• [${r.kind}] ${r.name}${r.provider ? ` (${r.provider})` : ''}: ${msg}`
  }).join('\n') + `\n\nSee /activity for full detail.`
  return { subject, text }
}

// Stateful digester: buffers eligible rows, sends one email per digest window.
export interface Digester { push: (rows: ActivityInsert[]) => void }

export function createEmailDigester(deps?: {
  send?: typeof sendResendEmail
  getConfig?: () => Promise<ObservabilityConfig>
  setTimer?: (fn: () => void, ms: number) => void
}): Digester {
  const send = deps?.send ?? sendResendEmail
  const getConfig = deps?.getConfig ?? loadObsConfig
  const setTimer = deps?.setTimer ?? ((fn, ms) => { setTimeout(fn, ms).unref?.() })
  let pending: ActivityInsert[] = []
  let armed = false

  async function fire() {
    armed = false
    const batch = pending; pending = []
    if (!batch.length) return
    try {
      const cfg = await getConfig()
      const e = cfg.alerts.email
      if (!e.enabled || !e.recipient || !e.apiKeyEnc) return
      const { subject, text } = buildDigest(batch)
      await send({ apiKey: decryptSecret(e.apiKeyEnc), from: e.from ?? 'mymind@localhost', to: e.recipient, subject, text })
    } catch (err) {
      console.error('[observability] email digest failed', err)
    }
  }

  return {
    push(rows) {
      getConfig().then((cfg) => {
        const eligible = rows.filter(r => shouldNotify(cfg, (r.severity as ActivitySeverity)))
        if (!eligible.length) return
        pending.push(...eligible)
        if (!armed) { armed = true; setTimer(() => { void fire() }, cfg.alerts.email.digestWindowMin * 60_000) }
      }).catch(() => {})
    }
  }
}
