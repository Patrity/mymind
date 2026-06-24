// Ping ComfyUI to confirm it's reachable. Inline baseURL (a not-yet-saved form value)
// or omit to use the stored config.
import { z } from 'zod'
import { loadImageConfig } from '../../lib/imagegen/store'

const Body = z.object({ baseURL: z.string().url().nullable().optional() })

export default defineEventHandler(async (event) => {
  const b = Body.parse(await readBody(event).catch(() => ({})))
  const baseURL = b.baseURL ?? (await loadImageConfig()).baseURL
  if (!baseURL) return { ok: false, message: 'no baseURL configured' }
  try {
    const res = await $fetch.raw(`${baseURL.replace(/\/$/, '')}/system_stats`, { signal: AbortSignal.timeout(10000) })
    return { ok: res.status < 400, message: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
})
