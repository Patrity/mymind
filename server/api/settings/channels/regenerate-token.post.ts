import { loadChannelsConfig, rotateWebhookToken, invalidateChannelsConfig, channelsConfigDTO } from '../../../lib/channels/config'
import { requireSession } from '../../../utils/auth-guard'

// Web session only. Rotates the BlueBubbles webhook token: the old URL stops working
// immediately (404); Tony must paste the new webhookUrlPath into BlueBubbles.
export default defineEventHandler(async (event) => {
  requireSession(event)

  await rotateWebhookToken()
  invalidateChannelsConfig()
  return channelsConfigDTO(await loadChannelsConfig())
})
