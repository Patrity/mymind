<!-- app/pages/settings/bridget.vue -->
<script setup lang="ts">
definePageMeta({ title: 'Bridget' })

// ── Self-improvement mode (cycle 76) ─────────────────────────────────────────
// One settings row read fresh by the reflection gate; saved as soon as it is picked.
type SelfImprovementMode = 'on' | 'review_only' | 'off'

const toast = useToast()
// `hint`, not `description`: USelect would render a description inside each option, truncated.
const modeItems: { label: string, value: SelfImprovementMode, hint: string }[] = [
  { label: 'On', value: 'on', hint: 'Safe changes apply on their own; the rest go to Review.' },
  { label: 'Review only', value: 'review_only', hint: 'Every proposed change waits for you in Review.' },
  { label: 'Off', value: 'off', hint: 'Bridget does not reflect on conversations or jobs.' }
]
const mode = ref<SelfImprovementMode | undefined>(undefined)
const savedMode = ref<SelfImprovementMode | undefined>(undefined)
const savingMode = ref(false)
const modeHint = computed(() => modeItems.find(i => i.value === mode.value)?.hint)

onMounted(async () => {
  try {
    const res = await $fetch<{ mode: SelfImprovementMode }>('/api/settings/self-improvement')
    mode.value = res.mode
    savedMode.value = res.mode
  } catch (e) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Could not load the self-improvement mode', description: err.data?.statusMessage ?? err.message })
  }
})

watch(mode, async (next) => {
  if (!next || next === savedMode.value) return
  savingMode.value = true
  try {
    const res = await $fetch<{ mode: SelfImprovementMode }>('/api/settings/self-improvement', { method: 'PUT', body: { mode: next } })
    savedMode.value = res.mode
    toast.add({ color: 'success', title: 'Self-improvement mode saved' })
  } catch (e) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Could not save the self-improvement mode', description: err.data?.statusMessage ?? err.message })
    mode.value = savedMode.value
  } finally {
    savingMode.value = false
  }
})
</script>

<template>
  <div class="flex flex-col gap-8">
    <SettingsPersonaTab />
    <div class="border-t border-default pt-6">
      <SettingsAgentTimezone />
    </div>
    <div
      class="border-t border-default pt-6 flex flex-col gap-3"
      data-testid="self-improvement"
    >
      <div>
        <h2 class="text-base font-semibold text-highlighted">
          Self-improvement
        </h2>
        <p class="text-sm text-muted">
          Bridget reviews her conversations and jobs and proposes changes to her skills, jobs and your profile.
        </p>
      </div>
      <USelect
        v-model="mode"
        :items="modeItems"
        value-key="value"
        class="w-72"
        :loading="!savedMode || savingMode"
        :disabled="!savedMode"
        data-testid="self-improvement-mode"
      />
      <p
        v-if="modeHint"
        class="text-xs text-dimmed"
      >
        {{ modeHint }}
      </p>
    </div>
  </div>
</template>
