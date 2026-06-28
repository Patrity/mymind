import { describe, it, expect } from 'vitest'
import { buildImg2ImgGraph } from './graph'
import type { ImageGenConfig, EditParams } from './types'

const config: ImageGenConfig = {
  baseURL: 'http://rig:8188',
  unetName: 'qwen_image_fp8_e4m3fn.safetensors',
  clipName: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
  vaeName: 'qwen_image_vae.safetensors',
  width: 1024, height: 1024, steps: 20, cfg: 2.5, sampler: 'euler', scheduler: 'simple', editStrength: 0.55,
  editUnetName: 'qwen_image_edit_2509_fp8_e4m3fn_lightning4.safetensors',
  editSteps: 4, editCfg: 1.0,
  editUnetQualityName: 'qwen_image_edit_2509_fp8_e4m3fn.safetensors',
  editStepsQuality: 20, editCfgQuality: 2.5, editShift: 3.0
}

describe('buildImg2ImgGraph', () => {
  it('wires the source image through LoadImage -> VAEEncode -> KSampler.latent_image', () => {
    const params: EditParams = { prompt: 'make the hat blue', negativePrompt: 'blurry', seed: 42, steps: 8, cfg: 3, strength: 0.6 }
    const g = buildImg2ImgGraph(params, config, 'src.png')
    expect(g['10']!.class_type).toBe('LoadImage')
    expect(g['10']!.inputs.image).toBe('src.png')
    expect(g['11']!.class_type).toBe('VAEEncode')
    expect(g['11']!.inputs.pixels).toEqual(['10', 0])
    expect(g['11']!.inputs.vae).toEqual(['3', 0])
    expect(g['7']!.inputs.latent_image).toEqual(['11', 0])
    expect(g['7']!.inputs.denoise).toBe(0.6)
    expect(g['7']!.inputs.seed).toBe(42)
    expect(g['7']!.inputs.steps).toBe(8)
    expect(g['4']!.inputs.text).toBe('make the hat blue')
    expect(g['5']!.inputs.text).toBe('blurry')
    expect(g['8']!.inputs.samples).toEqual(['7', 0])
    expect(g['9']!.class_type).toBe('SaveImage')
  })

  it('defaults strength to config.editStrength and applies steps/cfg defaults', () => {
    const g = buildImg2ImgGraph({ prompt: 'x', seed: 1 }, config, 'a.png')
    expect(g['7']!.inputs.denoise).toBe(0.55)
    expect(g['7']!.inputs.steps).toBe(20)
    expect(g['7']!.inputs.cfg).toBe(2.5)
    expect(g['5']!.inputs.text).toBe('')
  })
})
