<!-- app/components/settings/AnalyticsTab.vue -->
<script setup lang="ts">
import type { RigServiceDef } from '~~/server/lib/analytics/types'

const { useSettings, saveSettings } = useAnalytics()
const toast = useToast()
const { data: cfg } = useSettings()

const form = reactive({ prometheusUrl: '', litellmUrl: '', litellmMasterKey: '', rigHost: '' })
const gpuLabels = ref<{ uuid: string, label: string }[]>([])
const services = ref<RigServiceDef[]>([])

watch(cfg, (c) => {
  if (!c) return
  form.prometheusUrl = c.prometheusUrl
  form.litellmUrl = c.litellmUrl
  form.rigHost = c.rigHost
  gpuLabels.value = Object.entries(c.gpuLabels).map(([uuid, label]) => ({ uuid, label }))
  services.value = c.services.map(s => ({ ...s }))
}, { immediate: true })

const SOURCES = [{ label: 'up{}', value: 'up' }, { label: 'probe', value: 'probes' }]

function addService() {
  services.value.push({ id: '', label: '', source: 'probes', probeService: '', port: '', public: true })
}
function removeService(i: number) {
  services.value.splice(i, 1)
}

// Mirrors the server-side refine: a service with no usable matcher would never match and
// would sit on the strip as a permanent "unknown" instead of failing loudly.
function serviceError(s: RigServiceDef): string | null {
  if (!s.id.trim() || !s.label.trim()) return 'id and label are required'
  if (s.source === 'up') return s.job?.trim() ? null : 'an up{} service needs a job name'
  return (s.probeService?.trim() || s.port?.trim() || s.instanceContains?.trim())
    ? null
    : 'a probe needs a service label, a port, or an instance substring'
}
const errors = computed(() => services.value.map(serviceError))
const canSave = computed(() => errors.value.every(e => e === null))

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await saveSettings({
      prometheusUrl: form.prometheusUrl,
      litellmUrl: form.litellmUrl,
      litellmMasterKey: form.litellmMasterKey || undefined,
      rigHost: form.rigHost,
      gpuLabels: Object.fromEntries(gpuLabels.value.map(g => [g.uuid, g.label])),
      // Strip the empty optionals so a blank input is absent rather than "" on the row.
      services: services.value.map(s => ({
        id: s.id.trim(),
        label: s.label.trim(),
        source: s.source,
        public: s.public,
        ...(s.job?.trim() ? { job: s.job.trim() } : {}),
        ...(s.probeService?.trim() ? { probeService: s.probeService.trim() } : {}),
        ...(s.port?.trim() ? { port: s.port.trim() } : {}),
        ...(s.instanceContains?.trim() ? { instanceContains: s.instanceContains.trim() } : {}),
      })),
    })
    form.litellmMasterKey = ''
    toast.add({ color: 'success', title: 'Analytics settings saved' })
  } catch (e) {
    toast.add({ color: 'error', title: 'Save failed', description: (e as { data?: { statusMessage?: string } }).data?.statusMessage })
  } finally { saving.value = false }
}
</script>

<template>
  <div class="max-w-3xl space-y-6">
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
    <UFormField label="Rig host" help="Host the blackbox probe targets live on. Builds the probe instance regex.">
      <UInput v-model="form.rigHost" class="w-full" />
    </UFormField>

    <UFormField label="GPU labels"
                help="Optional. A GPU with no entry is named from nvidia_smi, so a new card is readable without adding it here.">
      <div class="space-y-2">
        <div v-for="g in gpuLabels" :key="g.uuid" class="flex items-center gap-2">
          <code class="w-28 shrink-0 truncate text-xs text-muted">{{ g.uuid.slice(0, 8) }}</code>
          <UInput v-model="g.label" class="w-full" size="sm" />
        </div>
      </div>
    </UFormField>

    <UFormField label="Health strip services"
                help="The service list on the public rig strip. The Prometheus queries that fetch these are built from this table, so retiring a service here also stops scraping it.">
      <div class="space-y-3">
        <div v-for="(s, i) in services" :key="i" class="rounded-lg border border-default p-3 space-y-2">
          <div class="flex items-center gap-2">
            <UInput v-model="s.id" placeholder="id" size="sm" class="w-40" />
            <UInput v-model="s.label" placeholder="label shown on the strip" size="sm" class="flex-1" />
            <UButton icon="i-lucide-trash-2" color="neutral" variant="ghost" size="sm"
                     :aria-label="`Remove ${s.label || 'service'}`" @click="removeService(i)" />
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <USelect v-model="s.source" :items="SOURCES" size="sm" class="w-28" />
            <UInput v-if="s.source === 'up'" v-model="s.job" placeholder="prometheus job" size="sm" class="w-52" />
            <template v-else>
              <UInput v-model="s.probeService" placeholder="probe service label" size="sm" class="w-48" />
              <UInput v-model="s.port" placeholder="port" size="sm" class="w-24" />
              <UInput v-model="s.instanceContains" placeholder="or instance substring (off-rig)" size="sm" class="w-56" />
            </template>
            <UCheckbox v-model="s.public" label="public" />
          </div>
          <p v-if="errors[i]" class="text-xs text-error">{{ errors[i] }}</p>
        </div>
        <UButton icon="i-lucide-plus" variant="soft" size="sm" @click="addService">Add service</UButton>
      </div>
    </UFormField>

    <UButton :loading="saving" :disabled="!canSave" @click="save">Save</UButton>
  </div>
</template>
