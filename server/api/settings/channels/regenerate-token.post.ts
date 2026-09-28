import { loadChannelsConfig, saveChannelsConfig, invalidateChannelsConfig, newWebhookToken, channelsConfigDTO } from '../../../lib/channels/config'

// Rotates the BlueBubbles webhook token. The old URL stops working immediately (404); Tony must
// paste the new webhookUrlPath into BlueBubbles.
export default defineEventHandler(async () => {
  const c = await loadChannelsConfig()
  await saveChannelsConfig({ ...c, imessage: { ...c.imessage, webhookToken: newWebhookToken() } })
  invalidateChannelsConfig()
  return channelsConfigDTO(await loadChannelsConfig())
})
