import { loadChannelsConfig, rotateWebhookToken, invalidateChannelsConfig, channelsConfigDTO } from '@mymind/core/lib/channels/config'
import { requireSession } from '../../../utils/auth-guard'
import { invalidateWorkerCache } from '@mymind/core/lib/bus/invalidate'

// Web session only. Rotates the BlueBubbles webhook token: the old URL stops working
// immediately (404); Tony must paste the new webhookUrlPath into BlueBubbles.
export default defineEventHandler(async (event) => {
  requireSession(event)

  await rotateWebhookToken()
  invalidateChannelsConfig()
  // apps/worker keeps its own copy (cycle 81, spec §3.6).
  await invalidateWorkerCache('channels')
  return channelsConfigDTO(await loadChannelsConfig())
})
