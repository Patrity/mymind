// Minimal Resend REST client — no SDK dependency. https://resend.com/docs/api-reference/emails/send-email
import { ofetch } from 'ofetch'
export async function sendResendEmail(opts: { apiKey: string, from: string, to: string, subject: string, text: string, html?: string }): Promise<void> {
  // Dev-only stub for acceptance runs (cycle 75): log and resolve instead of calling Resend.
  // `import.meta.dev` is false in every production build, so this can never ship active.
  if (process.env.RESEND_FAKE === '1' && import.meta.dev) {
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
