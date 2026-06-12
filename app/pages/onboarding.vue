<!-- app/pages/onboarding.vue -->
<script setup lang="ts">
definePageMeta({ title: 'Set up AI', layout: false })  // standalone, no sidebar
const config = useAiConfig()
const status = useAiConfigStatus()
const step = ref(0)
const importing = ref(false)
const importError = ref<string | null>(null)
onMounted(() => config.load())

const steps = [
  { title: 'Providers', description: 'Where models run', slot: 'providers' as const, icon: 'i-lucide-server' },
  { title: 'Models', description: 'Define models', slot: 'models' as const, icon: 'i-lucide-box' },
  { title: 'Assign', description: 'Reasoning + embeddings', slot: 'assignments' as const, icon: 'i-lucide-sliders-horizontal' }
]

const canFinish = computed(() =>
  (config.draft.value.assignments.reasoning?.length ?? 0) > 0 &&
  (config.draft.value.assignments.embeddings?.length ?? 0) > 0)

async function importEnv() {
  importing.value = true
  importError.value = null
  try {
    await config.importEnv()
  } catch (err) {
    importError.value = (err as { data?: { data?: string }; message?: string }).data?.data ?? (err as Error).message ?? 'Import failed'
  } finally {
    importing.value = false
  }
}
async function finish() {
  try {
    await config.save()
    await status.refresh()
    await navigateTo('/')
  } catch {
    // config.error is set by save() and rendered inside the AssignmentsTab on this step.
  }
}
</script>

<template>
  <div class="mx-auto flex min-h-svh max-w-3xl flex-col gap-6 p-6">
    <div>
      <h1 class="text-xl font-semibold text-highlighted">Set up your AI</h1>
      <p class="text-sm text-muted">Configure providers, define models, and assign them. You can change this later in Settings.</p>
    </div>

    <div class="flex items-center justify-between">
      <UStepper v-model="step" :items="steps" class="flex-1" />
      <UButton variant="subtle" icon="i-lucide-download" label="Import from environment" class="ml-4" :loading="importing" @click="importEnv" />
    </div>
    <UAlert v-if="importError" color="error" :title="importError" />

    <div class="min-h-0 flex-1">
      <SettingsProvidersTab v-if="step === 0" />
      <SettingsModelsTab v-else-if="step === 1" />
      <SettingsAssignmentsTab v-else />
    </div>

    <div class="flex items-center justify-between border-t border-default pt-4">
      <UButton v-if="step > 0" variant="ghost" label="Back" @click="step--" />
      <span v-else />
      <UButton v-if="step < 2" label="Next" trailing-icon="i-lucide-arrow-right" @click="step++" />
      <UButton v-else :disabled="!canFinish" :loading="config.saving.value" label="Finish" icon="i-lucide-check" @click="finish" />
    </div>
    <p v-if="step === 2 && !canFinish" class="text-xs text-muted">Assign at least one model to <b>reasoning</b> and <b>embeddings</b> to finish.</p>
  </div>
</template>
