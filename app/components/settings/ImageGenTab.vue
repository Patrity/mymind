<!-- app/components/settings/ImageGenTab.vue -->
<script setup lang="ts">
const { config, error, load, save, testConnection } = useImageConfig()
const toast = useToast()
const saving = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)

const form = reactive({
  baseURL: '',
  unetName: '',
  clipName: '',
  vaeName: '',
  width: 1024,
  height: 1024,
  steps: 20,
  cfg: 2.5,
  sampler: 'euler',
  scheduler: 'simple',
  editStrength: 0.72,
  editUnetName: '',
  editSteps: 4,
  editCfg: 1.0,
  editUnetQualityName: '',
  editStepsQuality: 20,
  editCfgQuality: 2.5,
  editShift: 3.0,
})

onMounted(async () => {
  await load()
  if (config.value) {
    form.baseURL = config.value.baseURL ?? ''
    form.unetName = config.value.unetName ?? ''
    form.clipName = config.value.clipName ?? ''
    form.vaeName = config.value.vaeName ?? ''
    form.width = config.value.width ?? 1024
    form.height = config.value.height ?? 1024
    form.steps = config.value.steps ?? 20
    form.cfg = config.value.cfg ?? 2.5
    form.sampler = config.value.sampler ?? 'euler'
    form.scheduler = config.value.scheduler ?? 'simple'
    form.editStrength = config.value.editStrength ?? 0.72
    form.editUnetName = config.value.editUnetName ?? ''
    form.editSteps = config.value.editSteps ?? 4
    form.editCfg = config.value.editCfg ?? 1.0
    form.editUnetQualityName = config.value.editUnetQualityName ?? ''
    form.editStepsQuality = config.value.editStepsQuality ?? 20
    form.editCfgQuality = config.value.editCfgQuality ?? 2.5
    form.editShift = config.value.editShift ?? 3.0
  }
})

async function onSave() {
  saving.value = true
  error.value = null
  try {
    await save({ ...form, baseURL: form.baseURL.trim() || null })
    toast.add({ title: 'Image gen config saved', color: 'success' })
  } catch {
    // error state set by composable
  } finally {
    saving.value = false
  }
}

async function onTest() {
  testResult.value = null
  error.value = null
  try {
    testResult.value = await testConnection(form.baseURL.trim() || null)
  } catch (e) {
    testResult.value = {
      ok: false,
      message:
        (e as { data?: { message?: string } }).data?.message ??
        (e as Error).message ??
        'Request failed',
    }
  }
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h2 class="text-base font-semibold text-highlighted">Image Generation</h2>
      <p class="text-sm text-muted">
        ComfyUI + Qwen-Image backend for the agent's <code>generate_image</code> tool.
      </p>
    </div>

    <div class="flex flex-col gap-4 max-w-xl">
      <UFormField label="ComfyUI URL" help="e.g. http://192.168.2.25:8188">
        <UInput
          v-model="form.baseURL"
          placeholder="http://192.168.2.25:8188"
          class="w-full"
        />
      </UFormField>

      <UFormField label="UNET (diffusion) filename">
        <UInput v-model="form.unetName" class="w-full" />
      </UFormField>

      <UFormField label="CLIP (text encoder) filename">
        <UInput v-model="form.clipName" class="w-full" />
      </UFormField>

      <UFormField label="VAE filename">
        <UInput v-model="form.vaeName" class="w-full" />
      </UFormField>

      <div class="grid grid-cols-2 gap-3">
        <UFormField label="Width">
          <UInput v-model.number="form.width" type="number" :min="256" :max="2048" class="w-full" />
        </UFormField>
        <UFormField label="Height">
          <UInput v-model.number="form.height" type="number" :min="256" :max="2048" class="w-full" />
        </UFormField>
        <UFormField label="Steps">
          <UInput v-model.number="form.steps" type="number" :min="1" :max="60" class="w-full" />
        </UFormField>
        <UFormField label="CFG">
          <UInput v-model.number="form.cfg" type="number" step="0.1" :min="0" :max="20" class="w-full" />
        </UFormField>
        <UFormField label="Sampler">
          <UInput v-model="form.sampler" class="w-full" />
        </UFormField>
        <UFormField label="Scheduler">
          <UInput v-model="form.scheduler" class="w-full" />
        </UFormField>
        <UFormField label="Edit strength (img2img denoise)">
          <UInput v-model.number="form.editStrength" type="number" step="0.05" :min="0" :max="1" class="w-full" />
        </UFormField>
      </div>

      <h3 class="text-sm font-semibold text-highlighted mt-2">Edit model (instruction editing)</h3>
      <div class="grid grid-cols-2 gap-3">
        <UFormField label="Edit UNET filename" class="col-span-2">
          <UInput v-model="form.editUnetName" class="w-full" />
        </UFormField>
        <UFormField label="Edit steps">
          <UInput v-model.number="form.editSteps" type="number" :min="1" :max="60" class="w-full" />
        </UFormField>
        <UFormField label="Edit CFG">
          <UInput v-model.number="form.editCfg" type="number" step="0.1" :min="0" :max="20" class="w-full" />
        </UFormField>
        <UFormField label="Edit UNET quality filename" class="col-span-2">
          <UInput v-model="form.editUnetQualityName" class="w-full" />
        </UFormField>
        <UFormField label="Edit steps (quality)">
          <UInput v-model.number="form.editStepsQuality" type="number" :min="1" :max="60" class="w-full" />
        </UFormField>
        <UFormField label="Edit CFG (quality)">
          <UInput v-model.number="form.editCfgQuality" type="number" step="0.1" :min="0" :max="20" class="w-full" />
        </UFormField>
        <UFormField label="Edit shift">
          <UInput v-model.number="form.editShift" type="number" step="0.1" :min="0" :max="10" class="w-full" />
        </UFormField>
      </div>
    </div>

    <div class="flex items-center gap-3 border-t border-default pt-4">
      <UButton label="Save" color="primary" :loading="saving" @click="onSave()" />
      <UButton label="Test connection" variant="soft" @click="onTest()" />
      <span
        v-if="testResult"
        class="text-sm"
        :class="testResult.ok ? 'text-success' : 'text-error'"
      >{{ testResult.message }}</span>
    </div>

    <UAlert
      v-if="error"
      color="error"
      icon="i-lucide-alert-circle"
      :title="error"
    />
  </div>
</template>
