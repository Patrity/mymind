// server/lib/imagegen/graph.ts
// Pure builder: turn resolved generation params into a ComfyUI API-format graph.
// No I/O, no clock — the caller resolves `seed` so this stays deterministic/testable.
import type { ComfyGraph, GenerateParams, EditParams, ImageGenConfig } from './types'

/**
 * Optional override path: a stored workflow JSON with %PROMPT% / %NEGATIVE% /
 * %SEED% / %WIDTH% / %HEIGHT% / %STEPS% / %CFG% placeholders. Numeric placeholders
 * are substituted as raw JSON numbers; string placeholders as JSON strings.
 */
function applyWorkflowOverride(json: string, params: GenerateParams, config: ImageGenConfig): ComfyGraph {
  const sub = json
    .replace(/"%PROMPT%"/g, JSON.stringify(params.prompt))
    .replace(/"%NEGATIVE%"/g, JSON.stringify(params.negativePrompt ?? ''))
    .replace(/"%SEED%"/g, String(params.seed))
    .replace(/"%WIDTH%"/g, String(params.width ?? config.width))
    .replace(/"%HEIGHT%"/g, String(params.height ?? config.height))
    .replace(/"%STEPS%"/g, String(params.steps ?? config.steps))
    .replace(/"%CFG%"/g, String(params.cfg ?? config.cfg))
  return JSON.parse(sub) as ComfyGraph
}

export function buildComfyGraph(params: GenerateParams, config: ImageGenConfig): ComfyGraph {
  if (config.workflowJson && config.workflowJson.trim()) {
    return applyWorkflowOverride(config.workflowJson, params, config)
  }
  const width = params.width ?? config.width
  const height = params.height ?? config.height
  const steps = params.steps ?? config.steps
  const cfg = params.cfg ?? config.cfg
  const batch = params.batchSize ?? 1
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: config.unetName, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: config.clipName, type: 'qwen_image' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: config.vaeName } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt ?? '', clip: ['2', 0] } },
    '6': { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: batch } },
    '7': { class_type: 'KSampler', inputs: {
      seed: params.seed, steps, cfg, sampler_name: config.sampler, scheduler: config.scheduler, denoise: 1,
      model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0]
    } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'mymind', images: ['8', 0] } }
  }
}

/**
 * img2img: same loaders/encoders as the text-to-image graph, but the latent comes
 * from encoding the uploaded source image (LoadImage -> VAEEncode) and KSampler runs
 * at denoise<1 (strength). The caller resolves `seed`; this stays pure.
 */
export function buildImg2ImgGraph(params: EditParams, config: ImageGenConfig, sourceFilename: string): ComfyGraph {
  const steps = params.steps ?? config.steps
  const cfg = params.cfg ?? config.cfg
  const denoise = params.strength ?? config.editStrength
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: config.unetName, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: config.clipName, type: 'qwen_image' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: config.vaeName } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt ?? '', clip: ['2', 0] } },
    '10': { class_type: 'LoadImage', inputs: { image: sourceFilename } },
    '11': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['3', 0] } },
    '7': { class_type: 'KSampler', inputs: {
      seed: params.seed, steps, cfg, sampler_name: config.sampler, scheduler: config.scheduler, denoise,
      model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['11', 0]
    } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'mymind-edit', images: ['8', 0] } }
  }
}
