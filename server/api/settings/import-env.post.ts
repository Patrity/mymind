// server/api/settings/import-env.post.ts
// One-time onboarding helper: seed the registry from leftover AI_* env vars.
// Reads process.env directly (runtimeConfig.ai was removed in Plan 1), encrypts
// keys server-side, saves, and returns the redacted doc — no plaintext to client.
import { saveConfig, invalidate } from '../../lib/ai/registry/store'
import { redactDoc } from '../../lib/ai/registry/schema'
import { encryptSecret } from '../../lib/ai/registry/crypto'
import { emptyDoc, EMBEDDING_DIM, type AiConfigDoc, type ProviderDef, type ModelDef } from '../../lib/ai/registry/types'

interface Src { env: string; usage: keyof AiConfigDoc['assignments']; dim?: number | null }
// Maps the old env roles → registry usages. ttsKokoro/ttsChatterbox both map to tts.
const SOURCES: Src[] = [
  { env: 'AI_REASONING', usage: 'reasoning' },
  { env: 'AI_BULK', usage: 'bulk' },
  { env: 'AI_EMBEDDINGS', usage: 'embeddings', dim: EMBEDDING_DIM },
  { env: 'AI_VISION', usage: 'vision' },
  { env: 'AI_STT', usage: 'stt' },
  { env: 'AI_TTS_KOKORO', usage: 'tts' },
  { env: 'AI_TTS_CHATTERBOX', usage: 'tts' },
  { env: 'AI_RERANK', usage: 'rerank' }
]

export default defineEventHandler(async () => {
  const doc = emptyDoc()
  const e = process.env

  for (const src of SOURCES) {
    const baseURL = e[`${src.env}_BASE_URL`]
    if (!baseURL) continue
    const apiKey = e[`${src.env}_API_KEY`] || ''
    const modelId = e[`${src.env}_MODEL`] || src.usage
    // One provider per source (dedupe by baseURL+key so shared rigs collapse).
    let provider = doc.providers.find(p => p.baseURL === baseURL)
    if (!provider) {
      provider = { id: crypto.randomUUID(), name: src.env.replace(/^AI_/, '').toLowerCase(), kind: 'openai-compatible', baseURL, apiKeyEnc: apiKey ? encryptSecret(apiKey) : null } satisfies ProviderDef
      doc.providers.push(provider)
    }
    const model: ModelDef = { id: crypto.randomUUID(), providerId: provider.id, modelId, label: `${src.usage}: ${modelId}`, dim: src.dim ?? null }
    doc.models.push(model)
    doc.assignments[src.usage].push(model.id)
  }

  await saveConfig(doc)
  invalidate()
  return redactDoc(doc)
})
