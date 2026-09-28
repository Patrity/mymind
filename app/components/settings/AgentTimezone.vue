<!-- app/components/settings/AgentTimezone.vue -->
<!-- The zone scheduled jobs use when their file names no `timezone:` (cycle 74 final review I5).
     Saving re-derives every such job's stored zone and next run on the server. -->
<script setup lang="ts">
interface TzState { timezone: string | null, effective: string, server: string, rederived?: number }

const toast = useToast()
// reka-ui rejects an empty-string item value, so "unset" is a non-empty sentinel.
const SERVER = '__server__'

const state = ref<TzState | null>(null)
const selected = ref<string>(SERVER)
const saving = ref(false)
const error = ref('')
// Read in onMounted: during SSR this would be the server's zone, not the browser's.
const browserTz = ref('')

const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
const items = computed(() => {
  const list = [...zones]
  if (state.value?.timezone && !list.includes(state.value.timezone)) list.unshift(state.value.timezone)
  return [
    { label: `Server default (${state.value?.server ?? '…'})`, value: SERVER },
    ...list.map(z => ({ label: z, value: z }))
  ]
})
const stored = computed(() => state.value?.timezone ?? SERVER)
const dirty = computed(() => !!state.value && selected.value !== stored.value)

onMounted(async () => {
  browserTz.value = Intl.DateTimeFormat().resolvedOptions().timeZone
  state.value = await $fetch<TzState>('/api/settings/agent-timezone')
  selected.value = stored.value
})

async function save() {
  saving.value = true
  error.value = ''
  try {
    const res = await $fetch<TzState>('/api/settings/agent-timezone', {
      method: 'PUT', body: { timezone: selected.value === SERVER ? null : selected.value }
    })
    state.value = res
    selected.value = stored.value
    const n = res.rederived ?? 0
    toast.add({ title: 'Agent timezone saved', description: `${n} job${n === 1 ? '' : 's'} now follow ${res.effective}.`, color: 'success' })
  } catch (e) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    error.value = err.data?.statusMessage ?? 'Failed to save the agent timezone'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="agent-timezone">
    <div>
      <h2 class="text-base font-semibold text-highlighted">Agent timezone</h2>
      <p class="text-sm text-muted">
        The timezone Bridget's scheduled jobs use when their file does not name one. Changing it moves
        those jobs' fire times straight away; a job with its own <code>timezone:</code> line is unaffected.
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <USelectMenu
        v-model="selected"
        :items="items"
        value-key="value"
        class="w-72"
        :loading="!state"
        data-testid="agent-timezone-select"
      />
      <UButton
        v-if="browserTz && selected !== browserTz"
        :label="`Use browser timezone (${browserTz})`"
        color="neutral"
        variant="soft"
        data-testid="agent-timezone-browser"
        @click="selected = browserTz"
      />
    </div>
    <p v-if="state" class="text-xs text-dimmed">
      Jobs currently use {{ state.effective }}.
    </p>
    <div class="flex items-center gap-3">
      <UButton label="Save timezone" color="primary" :loading="saving" :disabled="!dirty" data-testid="agent-timezone-save" @click="save()" />
      <UAlert v-if="error" color="error" icon="i-lucide-alert-circle" :title="error" class="flex-1" />
    </div>
  </div>
</template>
