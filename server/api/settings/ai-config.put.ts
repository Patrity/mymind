import { z } from 'zod'
import { loadConfig, saveConfig, invalidate } from '../../lib/ai/registry/store'
import { parseConfig } from '../../lib/ai/registry/schema'
import { encryptSecret } from '../../lib/ai/registry/crypto'
import { resolveChainFrom } from '../../lib/ai/registry/resolve'
import { EMBEDDING_DIM, USAGES, type AiConfigDoc } from '../../lib/ai/registry/types'

const KeyField = z.union([z.object({ apiKey: z.string().min(1) }), z.object({ keep: z.literal(true) }), z.null()])
const Body = z.object({
  version: z.literal(1),
  providers: z.array(z.object({
    id: z.string(), name: z.string(), kind: z.enum(['openai-compatible']),
    baseURL: z.string().url().nullable(), key: KeyField
  })),
  models: z.array(z.object({ id: z.string(), providerId: z.string(), modelId: z.string(), label: z.string(), dim: z.number().int().positive().nullable() })),
  assignments: z.object(Object.fromEntries(USAGES.map(u => [u, z.array(z.string())])))
})

export default defineEventHandler(async (event) => {
  let body: z.infer<typeof Body>
  try {
    body = Body.parse(await readBody(event))
  } catch (err) {
    // Honor a blanket 422 for invalid input (raw shape + referential alike).
    throw createError({ statusCode: 422, statusMessage: 'Invalid request body', data: (err as Error).message })
  }
  const existing = await loadConfig()
  const prevKey = new Map(existing.providers.map(p => [p.id, p.apiKeyEnc]))

  // Resolve each provider's apiKeyEnc from the key field.
  const providers = body.providers.map((p) => {
    let apiKeyEnc: string | null = null
    if (p.key && 'apiKey' in p.key) apiKeyEnc = encryptSecret(p.key.apiKey)
    else if (p.key && 'keep' in p.key) apiKeyEnc = prevKey.get(p.id) ?? null
    else apiKeyEnc = null
    return { id: p.id, name: p.name, kind: p.kind, baseURL: p.baseURL, apiKeyEnc }
  })

  let doc: AiConfigDoc
  try {
    doc = parseConfig({ version: 1, providers, models: body.models, assignments: body.assignments })
  } catch (err) {
    throw createError({ statusCode: 422, statusMessage: 'Invalid config', data: (err as Error).message })
  }

  // Embeddings dim probe: the primary embedding model must produce EMBEDDING_DIM vectors.
  if (doc.assignments.embeddings.length) {
    const [m] = resolveChainFrom(doc, 'embeddings')
    try {
      const raw = await $fetch<unknown>(`${(m!.baseURL ?? '').replace(/\/$/, '')}/embed`, {
        method: 'POST', headers: m!.apiKey ? { authorization: `Bearer ${m!.apiKey}` } : undefined,
        body: { inputs: ['probe'], normalize: true }, signal: AbortSignal.timeout(15000)
      })
      const v = Array.isArray(raw) ? (raw as number[][])[0] : ((raw as { embeddings?: number[][] }).embeddings ?? (raw as { data?: number[][] }).data)?.[0]
      if (!Array.isArray(v) || v.length !== EMBEDDING_DIM) {
        throw createError({ statusCode: 422, statusMessage: `Embedding model returned ${Array.isArray(v) ? v.length : '?'} dims, expected ${EMBEDDING_DIM}` })
      }
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 422) throw err
      throw createError({ statusCode: 422, statusMessage: 'Embedding probe failed', data: `Could not verify the embedding model's output dimensions (endpoint unreachable, timed out, or returned an unexpected response): ${(err as Error).message}` })
    }
  }

  await saveConfig(doc)
  invalidate()
  return { ok: true }
})
