// server/lib/imagegen/store.ts
// Thin DB I/O for the single image_config JSONB row + an in-process cache.
// Mirrors server/lib/search/store.ts: module-level cache, explicit invalidation.
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import type { ImageGenConfig } from './types'

const KEY = 'image_config'
let cache: ImageGenConfig | null = null

export function defaultImageConfig(): ImageGenConfig {
  return {
    baseURL: null,
    unetName: 'qwen_image_fp8_e4m3fn.safetensors',
    clipName: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
    vaeName: 'qwen_image_vae.safetensors',
    width: 1024, height: 1024, steps: 20, cfg: 2.5, sampler: 'euler', scheduler: 'simple',
    editUnetName: 'qwen_image_edit_2509_fp8_e4m3fn_lightning4.safetensors',
    editSteps: 4,
    editCfg: 1.0,
    editUnetQualityName: 'qwen_image_edit_2509_fp8_e4m3fn.safetensors',
    editStepsQuality: 20,
    editCfgQuality: 2.5,
    editShift: 3.0,
    editStrength: 0.72
  }
}

export function mergeImageConfig(raw: Partial<ImageGenConfig> | null | undefined): ImageGenConfig {
  return { ...defaultImageConfig(), ...(raw ?? {}) }
}

// Empty-string baseURL -> null (unconfigured); otherwise must be a URL.
const baseURLSchema = z.preprocess(
  v => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().url().nullable()
)

export const imageConfigInputSchema = z.object({
  baseURL: baseURLSchema.optional(),
  unetName: z.string().min(1).optional(),
  clipName: z.string().min(1).optional(),
  vaeName: z.string().min(1).optional(),
  width: z.number().int().min(256).max(2048).optional(),
  height: z.number().int().min(256).max(2048).optional(),
  steps: z.number().int().min(1).max(60).optional(),
  cfg: z.number().min(0).max(20).optional(),
  sampler: z.string().min(1).optional(),
  scheduler: z.string().min(1).optional(),
  editStrength: z.number().min(0).max(1).optional(),
  editUnetName: z.string().min(1).optional(),
  editSteps: z.number().int().min(1).max(60).optional(),
  editCfg: z.number().min(0).max(20).optional(),
  editUnetQualityName: z.string().min(1).optional(),
  editStepsQuality: z.number().int().min(1).max(60).optional(),
  editCfgQuality: z.number().min(0).max(20).optional(),
  editShift: z.number().min(0).max(10).optional(),
  workflowJson: z.string().optional()
})

export function parseImageConfigInput(raw: unknown): Partial<ImageGenConfig> {
  return imageConfigInputSchema.parse(raw) as Partial<ImageGenConfig>
}

export async function loadImageConfig(): Promise<ImageGenConfig> {
  if (cache) return cache
  const [row] = await useDb().select().from(settings).where(eq(settings.key, KEY)).limit(1)
  cache = mergeImageConfig(row?.value as Partial<ImageGenConfig> | undefined)
  return cache
}

export async function saveImageConfig(input: Partial<ImageGenConfig>): Promise<ImageGenConfig> {
  const current = await loadImageConfig()
  const next: ImageGenConfig = { ...current, ...input }
  await useDb().insert(settings)
    .values({ key: KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
  cache = next
  return next
}

export function invalidateImageConfig(): void { cache = null }
