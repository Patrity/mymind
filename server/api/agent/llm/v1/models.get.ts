import { isPrivateAddress } from '../../../../utils/net'

// Unmute health/discovery probes `${KYUTAI_LLM_URL}/v1/models` (main_websocket.py).
// Return a minimal OpenAI-shaped model list so that path is satisfied.
export default defineEventHandler((event) => {
  const ip = getRequestIP(event, { xForwardedFor: true })
  if (!isPrivateAddress(ip)) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden (LAN only)' })
  }
  return {
    object: 'list',
    data: [{ id: 'mymind-agent', object: 'model', created: 0, owned_by: 'mymind' }]
  }
})
