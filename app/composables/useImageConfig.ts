// app/composables/useImageConfig.ts
export interface ImageConfig {
  baseURL: string | null
  unetName: string
  clipName: string
  vaeName: string
  width: number
  height: number
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  editStrength: number
  editUnetName: string
  editSteps: number
  editCfg: number
  editUnetQualityName: string
  editStepsQuality: number
  editCfgQuality: number
  editShift: number
  workflowJson?: string
}

export function useImageConfig() {
  const config = useState<ImageConfig | null>('image-config', () => null)
  const error = useState<string | null>('image-config-err', () => null)

  async function load() {
    config.value = await $fetch<ImageConfig>('/api/settings/image-config')
  }

  async function save(patch: Partial<ImageConfig>) {
    error.value = null
    try {
      config.value = await $fetch<ImageConfig>('/api/settings/image-config', {
        method: 'PUT',
        body: patch,
      })
    } catch (e) {
      error.value =
        (e as { data?: { message?: string } }).data?.message ??
        (e as Error).message
      throw e
    }
  }

  async function testConnection(baseURL: string | null) {
    return await $fetch<{ ok: boolean; message: string }>(
      '/api/settings/test-image-provider',
      { method: 'POST', body: { baseURL } },
    )
  }

  return { config, error, load, save, testConnection }
}
