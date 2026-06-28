// server/lib/imagegen/comfy.ts
// ComfyUI client: POST /prompt -> poll /history -> GET /view. Never throws on an
// expected backend failure — returns { ok:false, error } (the web_fetch convention).
import { buildComfyGraph, buildQwenEditGraph } from './graph'
import { loadImageConfig } from './store'
import type { GenerateParams, GenerateResult, ImageGenConfig } from './types'

// `$fetch` is Nitro's ambient global (ofetch) — used bare here exactly like
// server/lib/ai/embeddings.ts. Do NOT `declare const $fetch` (clashes with the
// ambient global type). Tests stub it via vi.stubGlobal('$fetch', ...).

const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
function mimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? 'png'
  return MIME_BY_EXT[ext] ?? 'image/png'
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Pure: find the first node output carrying images[] for the given prompt id. */
export function extractOutputImage(history: unknown, promptId: string): { filename: string; subfolder: string; type: string } | null {
  const entry = (history as Record<string, { outputs?: Record<string, { images?: unknown[] }> }>)?.[promptId]
  const outputs = entry?.outputs
  if (!outputs) return null
  for (const node of Object.values(outputs)) {
    const img = node?.images?.[0] as { filename?: string; subfolder?: string; type?: string } | undefined
    if (img?.filename) return { filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' }
  }
  return null
}

function randomSeed(): number {
  // Normal server code (not a workflow script) — Math.random is allowed here.
  return Math.floor(Math.random() * 2 ** 32)
}

export async function generateImage(
  params: { prompt: string; negativePrompt?: string; width?: number; height?: number; steps?: number; cfg?: number; seed?: number; batchSize?: number },
  opts: { signal?: AbortSignal; config?: ImageGenConfig; clientId?: string; pollIntervalMs?: number; maxWaitMs?: number } = {}
): Promise<GenerateResult> {
  if (opts.signal?.aborted) return { ok: false, error: 'aborted' }

  try {
    // loadImageConfig() touches the DB (useDb()) — keep it inside the try so a
    // DB-unavailable / pool-exhausted throw surfaces as { ok:false } and never escapes.
    const config = opts.config ?? await loadImageConfig()
    if (!config.baseURL) return { ok: false, error: 'image generation not configured (set a ComfyUI URL in /settings → Image Gen)' }

    const base = config.baseURL.replace(/\/$/, '')
    const seed = params.seed ?? randomSeed()
    const resolved: GenerateParams = { ...params, seed }
    const width = params.width ?? config.width
    const height = params.height ?? config.height
    const steps = params.steps ?? config.steps
    const cfg = params.cfg ?? config.cfg
    const clientId = opts.clientId ?? `mymind-${seed}-${Date.now()}`
    const pollIntervalMs = opts.pollIntervalMs ?? 1500
    const maxWaitMs = opts.maxWaitMs ?? 180_000

    const graph = buildComfyGraph(resolved, config)
    const submit = await $fetch<{ prompt_id?: string }>(`${base}/prompt`, {
      method: 'POST', body: { prompt: graph, client_id: clientId }, signal: opts.signal
    })
    const promptId = submit?.prompt_id
    if (!promptId) return { ok: false, error: 'ComfyUI did not return a prompt_id' }

    const start = Date.now()
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (opts.signal?.aborted) return { ok: false, error: 'aborted' }
      if (Date.now() - start > maxWaitMs) return { ok: false, error: `image generation timed out after ${Math.round(maxWaitMs / 1000)}s` }
      const history = await $fetch(`${base}/history/${promptId}`, { signal: opts.signal })
      const out = extractOutputImage(history, promptId)
      if (out) {
        const q = new URLSearchParams({ filename: out.filename, subfolder: out.subfolder, type: out.type })
        const ab = await $fetch<ArrayBuffer>(`${base}/view?${q.toString()}`, { responseType: 'arrayBuffer', signal: opts.signal })
        return { ok: true, buffer: Buffer.from(ab), mime: mimeFromName(out.filename), meta: { seed, width, height, steps, cfg } }
      }
      await sleep(pollIntervalMs)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (opts.signal?.aborted) return { ok: false, error: 'aborted' }
    return { ok: false, error: message }
  }
}

// reverse of MIME_BY_EXT for naming the upload (webp/png/jpg); defaults to 'png'.
function mimeToExt(mime: string): string {
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/jpeg') return 'jpg'
  return 'png'
}

/** Upload a source image to ComfyUI's input store; returns the referenceable filename. Never throws. */
export async function uploadSourceImage(
  bytes: Buffer, filename: string, opts: { config: ImageGenConfig; signal?: AbortSignal }
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const base = opts.config.baseURL?.replace(/\/$/, '')
  if (!base) return { ok: false, error: 'image generation not configured (set a ComfyUI URL in /settings -> Image Gen)' }
  try {
    const fd = new FormData()
    fd.append('image', new Blob([new Uint8Array(bytes)]), filename)
    fd.append('overwrite', 'true')
    const r = await $fetch<{ name?: string; subfolder?: string }>(`${base}/upload/image`, { method: 'POST', body: fd, signal: opts.signal })
    if (!r?.name) return { ok: false, error: 'ComfyUI upload returned no filename' }
    return { ok: true, name: r.subfolder ? `${r.subfolder}/${r.name}` : r.name }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function editImage(
  params: { prompt: string; negativePrompt?: string; seed?: number; sourceBytes: Buffer; sourceMime: string },
  opts: { signal?: AbortSignal; config?: ImageGenConfig; clientId?: string; pollIntervalMs?: number; maxWaitMs?: number; quality?: boolean } = {}
): Promise<GenerateResult> {
  try {
    const config = opts.config ?? await loadImageConfig()
    if (!config.baseURL) return { ok: false, error: 'image generation not configured (set a ComfyUI URL in /settings -> Image Gen)' }
    const base = config.baseURL.replace(/\/$/, '')
    const seed = params.seed ?? randomSeed()
    const quality = opts.quality ?? false
    const steps = quality ? config.editStepsQuality : config.editSteps
    const cfg = quality ? config.editCfgQuality : config.editCfg
    const clientId = opts.clientId ?? `mymind-edit-${seed}-${Date.now()}`
    const pollIntervalMs = opts.pollIntervalMs ?? 1500
    const maxWaitMs = opts.maxWaitMs ?? 180_000
    if (opts.signal?.aborted) return { ok: false, error: 'aborted' }

    const ext = mimeToExt(params.sourceMime)
    const up = await uploadSourceImage(params.sourceBytes, `mymind-src-${seed}.${ext}`, { config, signal: opts.signal })
    if (!up.ok) return up

    const graph = buildQwenEditGraph({ prompt: params.prompt, negativePrompt: params.negativePrompt, seed }, config, up.name, { quality })
    const submit = await $fetch<{ prompt_id?: string }>(`${base}/prompt`, { method: 'POST', body: { prompt: graph, client_id: clientId }, signal: opts.signal })
    const promptId = submit?.prompt_id
    if (!promptId) return { ok: false, error: 'ComfyUI did not return a prompt_id' }

    const start = Date.now()
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (opts.signal?.aborted) return { ok: false, error: 'aborted' }
      if (Date.now() - start > maxWaitMs) return { ok: false, error: `image edit timed out after ${Math.round(maxWaitMs / 1000)}s` }
      const history = await $fetch(`${base}/history/${promptId}`, { signal: opts.signal })
      const out = extractOutputImage(history, promptId)
      if (out) {
        const q = new URLSearchParams({ filename: out.filename, subfolder: out.subfolder, type: out.type })
        const ab = await $fetch<ArrayBuffer>(`${base}/view?${q.toString()}`, { responseType: 'arrayBuffer', signal: opts.signal })
        return { ok: true, buffer: Buffer.from(ab), mime: mimeFromName(out.filename), meta: { seed, width: 0, height: 0, steps, cfg } }
      }
      await sleep(pollIntervalMs)
    }
  } catch (err) {
    if (opts.signal?.aborted) return { ok: false, error: 'aborted' }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
