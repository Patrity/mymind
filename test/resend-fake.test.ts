// RESEND_FAKE=1 stubs Resend in dev acceptance only (cycle 75 Task 13). The guard is
// `process.env.RESEND_FAKE === '1' && coreConfig().dev` (cycle 81: the host's dev flag replaced
// Nitro's import.meta.dev so the worker bundle can carry it): outside a dev host (vitest, prod, the
// worker bundle) the env var alone must never stop a real send.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendResendEmail } from '@mymind/core/lib/observability/email'
import * as config from '@mymind/core/config'

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

  it('on a dev host (coreConfig().dev), RESEND_FAKE=1 logs and never calls Resend', async () => {
    vi.stubEnv('RESEND_FAKE', '1')
    const real = config.coreConfig()
    const spy = vi.spyOn(config, 'coreConfig').mockReturnValue(new Proxy(real, { get: (t, k) => k === 'dev' ? true : Reflect.get(t, k) }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await sendResendEmail(opts)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(log.mock.calls[0]![0]).toMatch(/^\[resend-fake\] would send to=tony@example.com/)
    } finally { spy.mockRestore(); log.mockRestore() }
  })
})
