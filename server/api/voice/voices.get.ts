// server/api/voice/voices.get.ts
export default defineEventHandler(async () => {
  const ai = useRuntimeConfig().ai as Record<string, { baseURL?: string }>
  const out: { provider: 'kokoro' | 'chatterbox', voice: string }[] = []
  const providers: ['kokoro' | 'chatterbox', string][] = [['kokoro', 'ttsKokoro'], ['chatterbox', 'ttsChatterbox']]
  for (const [provider, key] of providers) {
    const base = ai[key]?.baseURL?.replace(/\/$/, '')
    if (!base) continue
    try {
      const data = await $fetch<{ voices?: string[] }>(`${base}/audio/voices`)
      for (const voice of data?.voices ?? []) if (typeof voice === 'string') out.push({ provider, voice })
    } catch { /* provider down — skip */ }
  }
  return { voices: out }
})
