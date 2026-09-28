// RESEND_FAKE=1 stubs Resend in dev acceptance only (cycle 75 Task 13). The guard is
// `process.env.RESEND_FAKE === '1' && import.meta.dev`: outside a dev build (vitest, prod) the
// env var alone must never stop a real send. The dev-side behaviour (log + resolve) is proven by
// the Task 13 fake acceptance run, where import.meta.dev is true.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendResendEmail } from '../server/lib/observability/email'

const opts = { apiKey: 'k', from: 'bridget@example.com', to: 'tony@example.com', subject: 's', text: 't' }

describe('RESEND_FAKE dev stub', () => {
  const fetchMock = vi.fn(async () => ({}))
  beforeEach(() => {
    fetchMock.mockClear()
    vi.stubGlobal('$fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('outside dev, RESEND_FAKE=1 still calls the Resend API', async () => {
    vi.stubEnv('RESEND_FAKE', '1')
    await sendResendEmail(opts)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.resend.com/emails')
  })
})
