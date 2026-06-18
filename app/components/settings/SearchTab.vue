<!-- app/components/settings/SearchTab.vue -->
<script setup lang="ts">
const toast = useToast()

const provider = ref<'searxng' | 'brave'>('searxng')
const searxngUrl = ref('')
const braveApiKey = ref('')
const hasBraveKey = ref(false)
const saving = ref(false)
const error = ref('')

const providerItems = [
  { label: 'SearXNG (self-hosted)', value: 'searxng' },
  { label: 'Brave Search API', value: 'brave' },
]

onMounted(async () => {
  const data = await $fetch('/api/settings/search')
  provider.value = data.provider as 'searxng' | 'brave'
  searxngUrl.value = data.searxngUrl
  hasBraveKey.value = data.hasBraveKey
})

async function save() {
  saving.value = true
  error.value = ''
  try {
    const body: { provider: string; searxngUrl: string; braveApiKey?: string } = {
      provider: provider.value,
      searxngUrl: searxngUrl.value,
    }
    if (braveApiKey.value.trim()) {
      body.braveApiKey = braveApiKey.value.trim()
    }
    const data = await $fetch('/api/settings/search', { method: 'PUT', body })
    hasBraveKey.value = data.hasBraveKey
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
        Configure the search provider used by Bridget and research tools.
      </p>
    </div>

    <div class="flex flex-col gap-4">
      <UFormField label="Provider">
        <USelect
          v-model="provider"
          :items="providerItems"
          value-key="value"
          class="w-64"
        />
      </UFormField>

      <UFormField label="SearXNG URL">
        <UInput
          v-model="searxngUrl"
          placeholder="http://searxng:8080"
          class="w-full max-w-md"
        />
      </UFormField>

      <UFormField label="Brave API Key">
        <UInput
          v-model="braveApiKey"
          type="password"
          :placeholder="hasBraveKey ? 'key set — leave blank to keep' : 'not set'"
          class="w-full max-w-md"
        />
      </UFormField>
    </div>

    <div class="flex items-center gap-3 border-t border-default pt-4">
      <UButton label="Save" color="primary" :loading="saving" @click="save()" />
      <UAlert v-if="error" color="error" icon="i-lucide-alert-circle" :title="error" class="flex-1" />
    </div>
  </div>
</template>
