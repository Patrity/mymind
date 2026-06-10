// server/api/voice/voices.get.ts
import { resolveChain } from '../../lib/ai/registry/resolve'

export default defineEventHandler(async () => {
  const out: { provider: string, voice: string }[] = []
  let chain
  try { chain = await resolveChain('tts') } catch { return { voices: [] } }
  for (const m of chain) {
    const base = (m.baseURL ?? '').replace(/\/$/, '')
    try {
      const data = await $fetch<{ voices?: string[] }>(`${base}/audio/voices`,
        { headers: m.apiKey ? { authorization: `Bearer ${m.apiKey}` } : undefined })
      for (const voice of data?.voices ?? []) if (typeof voice === 'string') out.push({ provider: m.label, voice })
    } catch { /* provider down — skip */ }
  }
  return { voices: out }
})
