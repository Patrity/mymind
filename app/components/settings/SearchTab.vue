<!-- app/components/settings/SearchTab.vue -->
<script setup lang="ts">
const toast = useToast()

const braveApiKey = ref('')
const hasBraveKey = ref(false)
const braveQps = ref(1)
const saving = ref(false)
const error = ref('')

onMounted(async () => {
  const data = await $fetch('/api/settings/search')
  hasBraveKey.value = data.hasBraveKey
  braveQps.value = data.braveQps
})

async function save() {
  saving.value = true
  error.value = ''
  try {
    const body: { braveQps: number; braveApiKey?: string } = { braveQps: Number(braveQps.value) }
    if (braveApiKey.value.trim()) {
      body.braveApiKey = braveApiKey.value.trim()
    }
    const data = await $fetch('/api/settings/search', { method: 'PUT', body })
    hasBraveKey.value = data.hasBraveKey
    braveQps.value = data.braveQps
    braveApiKey.value = ''
    toast.add({ title: 'Search config saved', color: 'success' })
  } catch {
    error.value = 'Failed to save search config'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h2 class="text-base font-semibold text-highlighted">Web Search</h2>
      <p class="text-sm text-muted">
        Brave Search powers web search for Bridget and research tools.
      </p>
    </div>

    <div class="flex flex-col gap-4">
      <UFormField label="Brave API Key">
        <UInput
          v-model="braveApiKey"
          type="password"
          :placeholder="hasBraveKey ? 'key set — leave blank to keep' : 'not set'"
          class="w-full max-w-md"
        />
      </UFormField>

      <UFormField label="Requests per second" description="Rate limit shared by web_search and research_web (burst of 3). Brave's free plan allows 1.">
        <UInput
          v-model.number="braveQps"
          type="number"
          min="0.1"
          max="50"
          step="0.5"
          class="w-32"
        />
      </UFormField>
    </div>

    <div class="flex items-center gap-3 border-t border-default pt-4">
      <UButton label="Save" color="primary" :loading="saving" @click="save()" />
      <UAlert v-if="error" color="error" icon="i-lucide-alert-circle" :title="error" class="flex-1" />
    </div>
  </div>
</template>
