import {
  ChannelsPutBodySchema, ChannelsConfigError, type ChannelsPutBody,
  loadChannelsConfig, mergeChannelsPut, saveChannelsConfig, invalidateChannelsConfig, channelsConfigDTO
} from '../../lib/channels/config'

export default defineEventHandler(async (event) => {
  let body: ChannelsPutBody
  try { body = ChannelsPutBodySchema.parse(await readBody(event)) }
  catch (err) { throw createError({ statusCode: 422, statusMessage: 'Invalid channels config', data: (err as Error).message }) }

  let next
  try { next = mergeChannelsPut(await loadChannelsConfig(), body) }
  catch (err) {
    if (err instanceof ChannelsConfigError) throw createError({ statusCode: err.statusCode, statusMessage: err.message })
    throw err
  }
  await saveChannelsConfig(next)
  invalidateChannelsConfig()
  return channelsConfigDTO(await loadChannelsConfig())
})
