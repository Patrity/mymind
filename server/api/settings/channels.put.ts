import {
  ChannelsPutBodySchema, ChannelsConfigError, type ChannelsPutBody,
  loadChannelsConfig, mergeChannelsPut, saveChannelsConfig, invalidateChannelsConfig, channelsConfigDTO
} from '@mymind/core/lib/channels/config'
import { resetHealth } from '@mymind/core/lib/channels/inbound'
import { requireSession } from '../../utils/auth-guard'

// Web session only: a machine token must not be able to change who can text the agent or
// where send_message goes. The webhook token is never written here (saveChannelsConfig keeps
// the stored one); rotate it via regenerate-token.
export default defineEventHandler(async (event) => {
  requireSession(event)

  let body: ChannelsPutBody
  try { body = ChannelsPutBodySchema.parse(await readBody(event)) }
  catch (err) { throw createError({ statusCode: 422, statusMessage: 'Invalid channels config', data: (err as Error).message }) }

  let next
  const prev = await loadChannelsConfig()
  try { next = mergeChannelsPut(prev, body) }
  catch (err) {
    if (err instanceof ChannelsConfigError) throw createError({ statusCode: err.statusCode, statusMessage: err.message })
    throw err
  }
  await saveChannelsConfig(next)
  invalidateChannelsConfig()
  // The last health check was of a different setup (or of none): the dot goes neutral until the
  // next catch-up tick checks this one (M6).
  const p = prev.imessage, n = next.imessage
  if ((n.enabled && !p.enabled) || n.serverUrl !== p.serverUrl || n.passwordEnc !== p.passwordEnc) resetHealth()
  return channelsConfigDTO(await loadChannelsConfig())
})
