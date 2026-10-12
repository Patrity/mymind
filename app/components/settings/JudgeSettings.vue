<!-- app/components/settings/JudgeSettings.vue -->
<!-- Cycle 84 (spec §2.3): the approval judge and Smart Approvals. Saved through the agent settings
     doc (PUT /api/settings/agent-settings), which tells the agent worker to drop its cached copy.
     The form logic lives in lib/agent/judge-settings-form.ts (unit-tested). -->
<script setup lang="ts">
import { DEFAULT_JUDGE_SETTINGS, JUDGE_CONFIDENCE_LIMITS, type JudgeSettings } from '@mymind/core/lib/agent/judge/types'
import { canSave as canSaveForm, formConfidenceError, formFrom, loadStateOf, patchFor, type JudgeForm, type LoadState } from '~/lib/agent/judge-settings-form'

const toast = useToast()

const saved = ref<JudgeSettings | null>(null)
const form = reactive<JudgeForm>(formFrom(DEFAULT_JUDGE_SETTINGS as JudgeSettings))
const load = ref<LoadState>('loading')
const problems = ref<string[]>([])
const loadError = ref<string | null>(null)
const saving = ref(false)

const confidenceError = computed(() => formConfidenceError(form))
// UInput's v-model is a string; the form also accepts a number (as loaded).
const confidenceText = computed<string>({ get: () => String(form.confidence), set: (v) => { form.confidence = v } })
const canSave = computed(() => canSaveForm(form, saved.value, load.value, saving.value))
const editable = computed(() => load.value === 'ok')

function apply(j: JudgeSettings) {
  saved.value = j
  Object.assign(form, formFrom(j))
}

function errText(e: unknown): string | undefined {
  const err = e as { data?: { statusMessage?: string, data?: string }, message?: string }
  return err.data?.data ?? err.data?.statusMessage ?? err.message
}

async function fetchSettings() {
  load.value = 'loading'
  loadError.value = null
  try {
    const res = await $fetch<{ judge: JudgeSettings, problems?: string[] }>('/api/settings/agent-settings')
    apply(res.judge)
    problems.value = res.problems ?? []
    load.value = loadStateOf(res)
  } catch (e) {
    saved.value = null
    loadError.value = errText(e) ?? 'unknown error'
    load.value = 'failed'
  }
}
onMounted(fetchSettings)

async function put(body: Record<string, unknown>, title: string) {
  saving.value = true
  try {
    const res = await $fetch<{ judge: JudgeSettings }>('/api/settings/agent-settings', { method: 'PUT', body })
    apply(res.judge)
    problems.value = []
    load.value = 'ok'
    toast.add({ color: 'success', title })
  } catch (e) {
    toast.add({ color: 'error', title: 'Could not save the judge settings', description: errText(e) })
  } finally {
    saving.value = false
  }
}

function save() {
  if (canSave.value) void put(patchFor(form), 'Judge settings saved')
}
/** A corrupt stored doc: write the defaults over it. */
function reset() {
  void put({ judge: { enabled: DEFAULT_JUDGE_SETTINGS.enabled, smartApprovals: { ...DEFAULT_JUDGE_SETTINGS.smartApprovals }, confidence: DEFAULT_JUDGE_SETTINGS.confidence } }, 'Judge settings reset to defaults')
}
</script>

<template>
  <div
    class="flex flex-col gap-4"
    data-testid="judge-settings"
    :data-load="load"
  >
    <div>
      <h2 class="text-base font-semibold text-highlighted">
        Judge
      </h2>
      <p class="text-sm text-muted">
        A second model reviews every approval card and shows its verdict. With Smart Approvals on, a
        call it approves with enough confidence runs without asking you. Host commands, risky rule
        matches and anything in a run that has read untrusted content always wait for you.
      </p>
    </div>
    <UAlert
      v-if="load === 'failed'"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="Couldn't load the judge settings"
      :description="`They can't be shown or changed right now (${loadError}). If Bridget can't read them either, Smart Approvals is off — it fails closed.`"
      :actions="[{ label: 'Retry', color: 'neutral', variant: 'outline', onClick: () => { void fetchSettings() } }]"
      data-testid="judge-load-failed"
    />
    <UAlert
      v-else-if="load === 'corrupt'"
      color="error"
      variant="subtle"
      icon="i-lucide-file-warning"
      title="The stored judge settings are corrupt — Smart Approvals is off"
      :description="`Bridget reads the unreadable fields (${problems.join(', ')}) as off, so nothing is auto-approved. Reset them to the defaults to edit them again.`"
      :actions="[{ label: 'Reset to defaults', color: 'error', variant: 'solid', loading: saving, onClick: reset }]"
      data-testid="judge-corrupt"
    />
    <!-- A failed load shows no controls at all: greyed-out defaults would read as the real values. -->
    <template v-if="load !== 'failed'">
    <USwitch
      v-model="form.enabled"
      label="Judge approval cards"
      description="Off: no verdicts and no Smart Approvals."
      :disabled="!editable"
      data-testid="judge-enabled"
    />
    <USwitch
      v-model="form.workstreams"
      label="Smart Approvals for workstreams"
      description="Background workstreams run approved calls without waiting for you."
      :disabled="!editable || !form.enabled"
      data-testid="judge-smart-workstreams"
    />
    <USwitch
      v-model="form.chat"
      label="Smart Approvals for chat"
      description="Calls in a conversation run without a card when the judge approves them."
      :disabled="!editable || !form.enabled"
      data-testid="judge-smart-chat"
    />
    <UFormField
      label="Confidence needed"
      :help="confidenceError ? undefined : `${JUDGE_CONFIDENCE_LIMITS.min}–${JUDGE_CONFIDENCE_LIMITS.max}. The judge must be at least this sure before a call runs on its own.`"
      :error="confidenceError ?? false"
      class="max-w-sm"
      data-testid="judge-confidence-field"
    >
      <UInput
        v-model="confidenceText"
        type="number"
        inputmode="decimal"
        :step="0.01"
        :disabled="!editable || !form.enabled"
        class="w-32"
        data-testid="judge-confidence"
      />
    </UFormField>
    <div>
      <UButton
        label="Save judge settings"
        color="primary"
        :loading="saving && load === 'ok'"
        :disabled="!canSave"
        data-testid="judge-save"
        @click="save()"
      />
    </div>
    </template>
  </div>
</template>
