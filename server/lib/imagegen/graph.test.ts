import { describe, it, expect } from 'vitest'
import { buildComfyGraph } from './graph'
import type { ImageGenConfig, GenerateParams } from './types'

const config: ImageGenConfig = {
  baseURL: 'http://rig:8188',
  unetName: 'qwen_image_fp8_e4m3fn.safetensors',
  clipName: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
  vaeName: 'qwen_image_vae.safetensors',
  width: 1024, height: 1024, steps: 20, cfg: 2.5, sampler: 'euler', scheduler: 'simple', editStrength: 0.55
}

describe('buildComfyGraph', () => {
  it('injects prompt, negative, size, steps, cfg, seed into the mapped nodes', () => {
    const params: GenerateParams = { prompt: 'a red bicycle', negativePrompt: 'blurry', seed: 42, steps: 8, cfg: 3, width: 768, height: 512 }
    const g = buildComfyGraph(params, config)
    expect(g['4']!.inputs.text).toBe('a red bicycle')
    expect(g['5']!.inputs.text).toBe('blurry')
    expect(g['6']!.inputs.width).toBe(768)
    expect(g['6']!.inputs.height).toBe(512)
    expect(g['6']!.inputs.batch_size).toBe(1)
    expect(g['7']!.inputs.seed).toBe(42)
    expect(g['7']!.inputs.steps).toBe(8)
    expect(g['7']!.inputs.cfg).toBe(3)
    expect(g['1']!.inputs.unet_name).toBe(config.unetName)
    expect(g['2']!.inputs.clip_name).toBe(config.clipName)
    expect(g['2']!.inputs.type).toBe('qwen_image')
    expect(g['3']!.inputs.vae_name).toBe(config.vaeName)
  })

  it('applies config defaults for omitted size/steps/cfg and empty negative', () => {
    const g = buildComfyGraph({ prompt: 'a cat', seed: 1 }, config)
    expect(g['6']!.inputs.width).toBe(1024)
    expect(g['6']!.inputs.height).toBe(1024)
    expect(g['7']!.inputs.steps).toBe(20)
    expect(g['7']!.inputs.cfg).toBe(2.5)
    expect(g['5']!.inputs.text).toBe('')
  })

  it('honors batchSize on EmptySD3LatentImage', () => {
    const g = buildComfyGraph({ prompt: 'x', seed: 1, batchSize: 3 }, config)
    expect(g['6']!.inputs.batch_size).toBe(3)
  })

  it('uses workflowJson override (with placeholder substitution) when set', () => {
    const tmpl = JSON.stringify({ '99': { class_type: 'X', inputs: { text: '%PROMPT%', seed: '%SEED%' } } })
    const g = buildComfyGraph({ prompt: 'hi', seed: 7 }, { ...config, workflowJson: tmpl })
    expect(g['99']!.inputs.text).toBe('hi')
    expect(g['99']!.inputs.seed).toBe(7)
  })
})
