// Minimal Resend REST client — no SDK dependency. https://resend.com/docs/api-reference/emails/send-email
export async function sendResendEmail(opts: { apiKey: string, from: string, to: string, subject: string, text: string, html?: string }): Promise<void> {
  await $fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
    body: { from: opts.from, to: [opts.to], subject: opts.subject, text: opts.text, ...(opts.html !== undefined ? { html: opts.html } : {}) },
    signal: AbortSignal.timeout(15_000)
  })
}
