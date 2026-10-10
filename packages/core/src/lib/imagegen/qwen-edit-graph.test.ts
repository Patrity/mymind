import { describe, it, expect } from 'vitest'
import { buildQwenEditGraph } from './graph'
import type { ImageGenConfig, EditParams } from './types'

const config: ImageGenConfig = {
  baseURL: 'http://rig:8188',
  unetName: 'qwen_image_fp8_e4m3fn.safetensors',
  clipName: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
  vaeName: 'qwen_image_vae.safetensors',
  width: 1024, height: 1024, steps: 20, cfg: 2.5, sampler: 'euler', scheduler: 'simple',
  editUnetName: 'qwen_image_edit_2509_fp8_e4m3fn_lightning4.safetensors',
  editSteps: 4, editCfg: 1.0,
  editUnetQualityName: 'qwen_image_edit_2509_fp8_e4m3fn.safetensors',
  editStepsQuality: 20, editCfgQuality: 2.5, editShift: 3.0
}

describe('buildQwenEditGraph', () => {
  it('wires the verified Qwen-Image-Edit-2509 graph (fast/default path)', () => {
    const params: EditParams = { prompt: 'change the hat to a blue cowboy hat', negativePrompt: '', seed: 42 }
    const g = buildQwenEditGraph(params, config, 'src.png')
    // loaders
    expect(g['37']!.class_type).toBe('UNETLoader')
    expect(g['37']!.inputs.unet_name).toBe(config.editUnetName)   // merged fast model
    expect(g['38']!.inputs.clip_name).toBe(config.clipName)
    expect(g['38']!.inputs.type).toBe('qwen_image')
    expect(g['39']!.inputs.vae_name).toBe(config.vaeName)
    // model chain
    expect(g['66']!.class_type).toBe('ModelSamplingAuraFlow')
    expect(g['66']!.inputs.model).toEqual(['37', 0])
    expect(g['66']!.inputs.shift).toBe(3.0)
    expect(g['75']!.class_type).toBe('CFGNorm')
    expect(g['75']!.inputs.model).toEqual(['66', 0])
    // source chain
    expect(g['78']!.class_type).toBe('LoadImage')
    expect(g['78']!.inputs.image).toBe('src.png')
    expect(g['117']!.class_type).toBe('FluxKontextImageScale')
    expect(g['117']!.inputs.image).toEqual(['78', 0])
    expect(g['88']!.class_type).toBe('VAEEncode')
    expect(g['88']!.inputs.pixels).toEqual(['117', 0])
    expect(g['88']!.inputs.vae).toEqual(['39', 0])
    // conditioning
    expect(g['111']!.class_type).toBe('TextEncodeQwenImageEditPlus')
    expect(g['111']!.inputs.prompt).toBe('change the hat to a blue cowboy hat')
    expect(g['111']!.inputs.image1).toEqual(['117', 0])
    expect(g['111']!.inputs.clip).toEqual(['38', 0])
    expect(g['111']!.inputs.vae).toEqual(['39', 0])
    expect(g['110']!.inputs.prompt).toBe('')
    // sampler
    expect(g['3']!.inputs.model).toEqual(['75', 0])
    expect(g['3']!.inputs.positive).toEqual(['111', 0])
    expect(g['3']!.inputs.negative).toEqual(['110', 0])
    expect(g['3']!.inputs.latent_image).toEqual(['88', 0])
    expect(g['3']!.inputs.steps).toBe(4)
    expect(g['3']!.inputs.cfg).toBe(1.0)
    expect(g['3']!.inputs.denoise).toBe(1.0)
    expect(g['8']!.inputs.samples).toEqual(['3', 0])
    expect(g['9']!.class_type).toBe('SaveImage')
  })

  it('quality path selects the unmerged model + 20 steps + cfg 2.5', () => {
    const g = buildQwenEditGraph({ prompt: 'x', seed: 1 }, config, 'a.png', { quality: true })
    expect(g['37']!.inputs.unet_name).toBe(config.editUnetQualityName)
    expect(g['3']!.inputs.steps).toBe(20)
    expect(g['3']!.inputs.cfg).toBe(2.5)
  })
})
