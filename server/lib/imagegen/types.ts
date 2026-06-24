// server/lib/imagegen/types.ts
// Contracts for the ComfyUI + Qwen-Image generation path. The persisted config
// is one settings row (key='image_config'); ComfyGraph is the API-format prompt
// graph POSTed to ComfyUI.

export interface ImageGenConfig {
  baseURL: string | null   // ComfyUI endpoint, e.g. http://192.168.2.25:8188 (null = unconfigured)
  unetName: string         // diffusion model filename
  clipName: string         // text-encoder filename
  vaeName: string          // vae filename
  width: number            // default canvas width
  height: number           // default canvas height
  steps: number            // default sampler steps
  cfg: number              // default cfg scale
  sampler: string          // KSampler sampler_name
  scheduler: string        // KSampler scheduler
  workflowJson?: string    // optional override graph (JSON string); when set it replaces the template
}

/** Tool inputs after Zod parsing. `seed` is resolved by the caller before buildComfyGraph. */
export interface GenerateParams {
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  steps?: number
  cfg?: number
  seed: number             // resolved (never undefined at graph-build time)
  batchSize?: number       // EmptySD3LatentImage batch_size (default 1)
}

/** ComfyUI API-format graph: node-id -> { class_type, inputs }. */
export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>

export type GenerateResult =
  | { ok: true; buffer: Buffer; mime: string; meta: { seed: number; width: number; height: number; steps: number; cfg: number } }
  | { ok: false; error: string }
