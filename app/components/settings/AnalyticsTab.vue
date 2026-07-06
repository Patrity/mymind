<!-- app/components/settings/AnalyticsTab.vue -->
<script setup lang="ts">
const { useSettings, saveSettings } = useAnalytics()
const toast = useToast()
const { data: cfg } = useSettings()

const form = reactive({ prometheusUrl: '', litellmUrl: '', litellmMasterKey: '' })
const gpuLabels = ref<{ uuid: string, label: string }[]>([])
watch(cfg, (c) => {
  if (!c) return
  form.prometheusUrl = c.prometheusUrl
  form.litellmUrl = c.litellmUrl
  gpuLabels.value = Object.entries(c.gpuLabels).map(([uuid, label]) => ({ uuid, label }))
}, { immediate: true })

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await saveSettings({
      prometheusUrl: form.prometheusUrl,
      litellmUrl: form.litellmUrl,
      litellmMasterKey: form.litellmMasterKey || undefined,
      gpuLabels: Object.fromEntries(gpuLabels.value.map(g => [g.uuid, g.label])),
    })
    form.litellmMasterKey = ''
    toast.add({ color: 'success', title: 'Analytics settings saved' })
  } catch (e) {
    toast.add({ color: 'error', title: 'Save failed', description: (e as { data?: { statusMessage?: string } }).data?.statusMessage })
  } finally { saving.value = false }
}
</script>

<template>
  <div class="max-w-2xl space-y-6">
    <UFormField label="Prometheus URL" help="Validated on save (buildinfo probe)">
      <UInput v-model="form.prometheusUrl" class="w-full" />
    </UFormField>
    <UFormField label="LiteLLM URL">
      <UInput v-model="form.litellmUrl" class="w-full" />
    </UFormField>
    <UFormField label="LiteLLM master key"
      :help="cfg?.hasLitellmKey ? 'A key is configured. Enter a new value to replace it.' : 'Required only for the request log.'">
      <UInput v-model="form.litellmMasterKey" type="password" class="w-full"
              :placeholder="cfg?.hasLitellmKey ? '••••••••  (configured)' : 'sk-…'" />
    </UFormField>
    <UFormField label="GPU labels" help="Friendly names per GPU UUID, used in chart legends">
      <div class="space-y-2">
        <div v-for="g in gpuLabels" :key="g.uuid" class="flex items-center gap-2">
          <code class="w-28 shrink-0 truncate text-xs text-muted">{{ g.uuid.slice(0, 8) }}</code>
          <UInput v-model="g.label" class="w-full" size="sm" />
        </div>
      </div>
    </UFormField>
    <UButton :loading="saving" @click="save">Save</UButton>
  </div>
</template>
