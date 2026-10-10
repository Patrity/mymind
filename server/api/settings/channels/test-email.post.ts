import { useDb } from '@mymind/core/db'
import { loadChannelsConfig, resendReady } from '@mymind/core/lib/channels/config'
import { emailSubject } from '@mymind/core/lib/channels/email/render'
import { insertDeliveries } from '@mymind/core/lib/channels/outbox'
import { publishChange } from '@mymind/core/utils/live-bus'
import { requireSession } from '../../../utils/auth-guard'

const EMAIL_TEST_TEXT = 'Test from MyMind ✅'

// POST /api/settings/channels/test-email — web session only (cycle 75). Queues a test email to the
// SAVED to-address through the outbox (source 'note', subject "Bridget · test"), so it is sent by
// the same worker, adapter and retries as a real delivery.
export default defineEventHandler(async (event) => {
  requireSession(event)

  const c = (await loadChannelsConfig()).email
  if (!c.enabled) throw createError({ statusCode: 400, statusMessage: 'Enable email and save before sending a test' })
  if (!c.to) throw createError({ statusCode: 400, statusMessage: 'Set the to-address and save before sending a test' })
  if (!(await resendReady())) throw createError({ statusCode: 400, statusMessage: 'Set the Resend API key and sender in Activity & Alerts first' })

  const [deliveryId] = await useDb().transaction(tx => insertDeliveries(tx, [{
    channel: 'email', target: c.to!, payload: { text: EMAIL_TEST_TEXT, subject: emailSubject('test') }, source: 'note'
  }]))
  if (deliveryId) publishChange({ resource: 'channelDelivery', action: 'created', id: deliveryId })
  return { deliveryId }
})
