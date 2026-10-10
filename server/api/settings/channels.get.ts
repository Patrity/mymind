import { loadChannelsConfig, channelsConfigDTO } from '@mymind/core/lib/channels/config'
import { requireSession } from '../../utils/auth-guard'

// Web session only (requireSession → 403 for API-token/OAuth clients). The password is never
// returned; the webhook token appears only inside `webhookUrlPath` so Tony can paste it into
// BlueBubbles (controller ruling, cycle 75).
export default defineEventHandler(async (event) => {
  requireSession(event)

  return channelsConfigDTO(await loadChannelsConfig())
})
