// Minimal Resend REST client — no SDK dependency. https://resend.com/docs/api-reference/emails/send-email
import { ofetch } from 'ofetch'
import { coreConfig } from '../../config'
export async function sendResendEmail(opts: { apiKey: string, from: string, to: string, subject: string, text: string, html?: string }): Promise<void> {
  // Dev-only stub for acceptance runs (cycle 75): log and resolve instead of calling Resend.
  // `coreConfig().dev` is the host's dev flag (cycle 81: was `import.meta.dev`, which the worker's
  // bundle can't see): false in every production build and in the worker bundle, so this can
  // never ship active.
  if (process.env.RESEND_FAKE === '1' && coreConfig().dev === true) {
    console.log(`[resend-fake] would send to=${opts.to} from=${opts.from} subject=${JSON.stringify(opts.subject)} text=${opts.text.length} chars${opts.html !== undefined ? `, html=${opts.html.length} chars` : ''}`)
    return
  }
  await ofetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
    body: { from: opts.from, to: [opts.to], subject: opts.subject, text: opts.text, ...(opts.html !== undefined ? { html: opts.html } : {}) },
    signal: AbortSignal.timeout(15_000)
  })
}
