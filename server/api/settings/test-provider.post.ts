// Ping a provider to confirm it's reachable + auth works. Inline config (a
// not-yet-saved provider from the form) or {keep:true} to reuse a stored key.
import { z } from 'zod'
import { loadConfig } from '../../lib/ai/registry/store'
import { decryptSecret } from '../../lib/ai/registry/crypto'

const Body = z.object({
  id: z.string().optional(),
  kind: z.enum(['openai-compatible']),
  baseURL: z.string().url().nullable(),
  apiKey: z.string().nullable()   // plaintext from the form, or null to reuse stored key by id
})

export default defineEventHandler(async (event) => {
  const b = Body.parse(await readBody(event))
  let apiKey = b.apiKey ?? ''
  if (!apiKey && b.id) {
    const cfg = await loadConfig()
    const enc = cfg.providers.find(p => p.id === b.id)?.apiKeyEnc
    if (enc) { try { apiKey = decryptSecret(enc) } catch { /* leave empty */ } }
  }
  try {
    const res = await $fetch.raw(`${(b.baseURL ?? '').replace(/\/$/, '')}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined, signal: AbortSignal.timeout(10000)
    })
    return { ok: res.status < 400, message: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
})
