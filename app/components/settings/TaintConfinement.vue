<!-- app/components/settings/TaintConfinement.vue -->
<!-- Cycle 86 (spec D6): the taint-confinement trial switch. On: a run that read mail/calendar content
     (or a workspace that handled it) runs its workspace commands under macOS sandbox-exec — no network,
     writes only inside the workspace, no secrets, no background shells. Saved through the agent settings
     doc (PUT /api/settings/agent-settings), which tells the agent worker to drop its cached copy. -->
<script setup lang="ts">
const toast = useToast()

const enabled = ref<boolean>(true)
const saved = ref<boolean | null>(null)
const corrupt = ref(false)
const loadError = ref<string | null>(null)
const saving = ref(false)

function errText(e: unknown): string | undefined {
  const err = e as { data?: { statusMessage?: string, data?: string }, message?: string }
  return err.data?.data ?? err.data?.statusMessage ?? err.message
}

async function fetchSetting() {
  loadError.value = null
  try {
    const res = await $fetch<{ taintConfinement: boolean, problems?: string[] }>('/api/settings/agent-settings')
    enabled.value = res.taintConfinement
    saved.value = res.taintConfinement
    corrupt.value = (res.problems ?? []).includes('taintConfinement')
  } catch (e) {
    loadError.value = errText(e) ?? 'unknown error'
  }
}
onMounted(fetchSetting)

watch(enabled, async (next) => {
  if (saved.value === null || next === saved.value) return
  saving.value = true
  try {
    const res = await $fetch<{ taintConfinement: boolean }>('/api/settings/agent-settings', { method: 'PUT', body: { taintConfinement: next } })
    saved.value = res.taintConfinement
    corrupt.value = false
    toast.add({ color: 'success', title: next ? 'Taint confinement on' : 'Taint confinement off' })
  } catch (e) {
    toast.add({ color: 'error', title: 'Could not save taint confinement', description: errText(e) })
    enabled.value = saved.value ?? true
  } finally {
    saving.value = false
  }
})
</script>

<template>
  <div
    class="flex flex-col gap-3"
    data-testid="taint-confinement"
  >
    <div>
      <h2 class="text-base font-semibold text-highlighted">
        Taint confinement (trial)
      </h2>
      <p class="text-sm text-muted">
        Bridget's workspace commands run on her Mac with full access. When a run has read mail, calendar
        or contacts (or a workspace has handled that content), its commands can instead run confined:
        no network, writes only inside the workspace, no secrets, no background shells. Every
        confinement is logged (<code>sandbox:confined</code> in Activity) and marked on the tool call,
        so you can judge what it costs. Eval worlds are always confined.
      </p>
    </div>
    <UAlert
      v-if="loadError"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="Couldn't load the setting"
      :description="`${loadError}. Bridget treats an unreadable setting as on.`"
      :actions="[{ label: 'Retry', color: 'neutral', variant: 'outline', onClick: () => { void fetchSetting() } }]"
      data-testid="taint-confinement-load-failed"
    />
    <UAlert
      v-else-if="corrupt"
      color="warning"
      variant="subtle"
      icon="i-lucide-file-warning"
      title="The stored value is unreadable — confinement is on"
      description="Toggle it to save a valid value."
      data-testid="taint-confinement-corrupt"
    />
    <USwitch
      v-if="!loadError"
      v-model="enabled"
      label="Confine tainted runs"
      description="Off: tainted runs' commands run unconfined (still without secrets)."
      :disabled="saved === null || saving"
      :loading="saving"
      data-testid="taint-confinement-switch"
    />
  </div>
</template>
