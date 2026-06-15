import { recordEvent, captureEnabled } from '../lib/observability/record'

const SKIP_PREFIXES = ['/api/auth', '/api/share', '/api/i', '/api/events', '/api/activity']

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    if (event.path?.startsWith('/api/')) {
      ;(event.context as Record<string, unknown>)._obsStart = Date.now()
    }
  })

  nitroApp.hooks.hook('afterResponse', async (event) => {
    const path = event.path ?? ''
    const pathname = path.split('?')[0] ?? path
    const start = event.context._obsStart as number | undefined
    if (!start || !pathname.startsWith('/api/')) return
    if (SKIP_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'))) return
    if (!(await captureEnabled('inbound'))) return

    const status = getResponseStatus(event)
    const client = event.context.client as { type?: string, tokenId?: string, userId?: string } | undefined
    recordEvent({
      kind: 'inbound',
      name: `${event.method ?? 'GET'} ${pathname}`,
      status: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'ok',
      severity: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      durationMs: Date.now() - start,
      meta: { status, method: event.method, who: client?.type ?? 'anon', tokenId: client?.tokenId, userId: client?.userId }
    })
  })
})
