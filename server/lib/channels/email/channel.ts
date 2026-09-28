// server/lib/channels/email/channel.ts
// The outbound email adapter: one delivery row -> one Resend email (markdown rendered to HTML).
// Resend's key + sender come from the observability alert config (Task 5 brief); the recipient
// is `d.target`, which the planner already set to config.email.to — this adapter only re-checks
// that the channel is still enabled before it sends (Review context, cycle 75).
import type { Channel, SendResult } from '../types'
import { loadChannelsConfig } from '../config'
import { loadObsConfig } from '../../observability/config'
import { decryptSecret } from '../../ai/registry/crypto'
import { sendResendEmail } from '../../observability/email'
import { renderEmail, emailSubject } from './render'

async function resendCreds(): Promise<{ apiKey: string, from: string } | null> {
  const e = (await loadObsConfig()).alerts.email
  if (!e.apiKeyEnc || !e.from) return null
  return { apiKey: decryptSecret(e.apiKeyEnc), from: e.from }
}

function failure(e: unknown): SendResult {
  const status = (e as { response?: { status?: number } })?.response?.status
  const retryable = typeof status !== 'number' || status >= 500
  return { ok: false, error: e instanceof Error ? e.message : String(e), retryable }
}

export const emailChannel: Channel = {
  id: 'email',

  async isEnabled() {
    const c = (await loadChannelsConfig()).email
    if (!c.enabled || !c.to) return false
    return (await resendCreds()) !== null
  },

  async send(d) {
    const c = (await loadChannelsConfig()).email
    if (!c.enabled) return { ok: false, error: 'email channel is disabled', retryable: false }

    const creds = await resendCreds()
    if (!creds) return { ok: false, error: 'Resend is not configured (missing API key or sender address)', retryable: false }

    const { html, text } = renderEmail(d.payload.text)
    const subject = d.payload.subject ?? emailSubject('message')

    try {
      await sendResendEmail({ apiKey: creds.apiKey, from: creds.from, to: d.target, subject, text, html })
      return { ok: true }
    }
    catch (e) {
      return failure(e)
    }
  }
}
