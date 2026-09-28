import { loadChannelsConfig, channelsConfigDTO } from '../../lib/channels/config'

// Session-authed. The password is never returned; the webhook token appears only inside
// `webhookUrlPath` so Tony can paste it into BlueBubbles (controller ruling, cycle 75).
export default defineEventHandler(async () => {
  return channelsConfigDTO(await loadChannelsConfig())
})
