import { useDb } from '../../../db'
import { loadChannelsConfig } from '../../../lib/channels/config'
import { imessageClient, directChatGuid } from '../../../lib/channels/bluebubbles/client'
import { catchUpTick } from '../../../lib/channels/inbound'
import { insertDeliveries } from '../../../lib/channels/outbox'
import { publishChange } from '../../../utils/live-bus'
import { requireSession } from '../../../utils/auth-guard'

const IMESSAGE_TEST_TEXT = 'Test from MyMind ✅'

// POST /api/settings/channels/test-imessage { send?: boolean } — web session only (cycle 75).
// Asks the SAVED BlueBubbles server for serverInfo (Private API state, version, iCloud account).
// With `send: true` it also queues "Test from MyMind ✅" to the default chat through the outbox
// (source 'note'), so the test takes the same path — retries, duplicate check — as a real reply.
// Either way it finishes with a forced catch-up tick, which refreshes lastHealth() and so the
// Channels status dot.
async function refreshHealth(): Promise<void> {
  await catchUpTick({ force: true }).catch(err => console.warn('[channels] test catch-up failed:', err instanceof Error ? err.message : err))
}

export default defineEventHandler(async (event) => {
  requireSession(event)
  const body = await readBody<{ send?: unknown } | null>(event).catch(() => null)

  const client = await imessageClient()
  if (!client) throw createError({ statusCode: 400, statusMessage: 'iMessage is not configured: enable it with a server URL and password, then save' })

  let info: Awaited<ReturnType<typeof client.serverInfo>>
  try { info = await client.serverInfo() }
  catch (err) {
    await refreshHealth()
    throw createError({ statusCode: 502, statusMessage: `BlueBubbles did not answer: ${err instanceof Error ? err.message : String(err)}` })
  }

  let deliveryId: string | undefined
  if (body?.send === true) {
    const c = (await loadChannelsConfig()).imessage
    if (!c.enabled) throw createError({ statusCode: 400, statusMessage: 'Enable iMessage and save before sending a test' })
    const target = c.defaultChatGuid ?? (c.defaultHandle ? directChatGuid(c.defaultHandle) : null)
    if (!target) throw createError({ statusCode: 400, statusMessage: 'Pick a default handle and save before sending a test' })
    ;[deliveryId] = await useDb().transaction(tx => insertDeliveries(tx, [{ channel: 'imessage', target, payload: { text: IMESSAGE_TEST_TEXT }, source: 'note' }]))
    if (deliveryId) publishChange({ resource: 'channelDelivery', action: 'created', id: deliveryId })
  }

  await refreshHealth()
  return { ...info, ...(deliveryId ? { deliveryId } : {}) }
})
