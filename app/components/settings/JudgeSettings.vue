<!-- app/components/settings/JudgeSettings.vue -->
<!-- Cycle 84 (spec §2.3): the approval judge and Smart Approvals. Saved through the agent settings
     doc (PUT /api/settings/agent-settings), which tells the agent worker to drop its cached copy. -->
<script setup lang="ts">
import { DEFAULT_JUDGE_SETTINGS, JUDGE_CONFIDENCE_LIMITS, type JudgeSettings } from '@mymind/core/lib/agent/judge/types'
import { judgeConfidenceError } from '~/lib/agent/judge-display'

const toast = useToast()

const saved = ref<JudgeSettings | null>(null)
const enabled = ref<boolean>(DEFAULT_JUDGE_SETTINGS.enabled)
const workstreams = ref<boolean>(DEFAULT_JUDGE_SETTINGS.smartApprovals.workstreams)
const chat = ref<boolean>(DEFAULT_JUDGE_SETTINGS.smartApprovals.chat)
// A string while typing, so an out-of-range or half-typed value stays visible with its error.
const confidence = ref<string>(String(DEFAULT_JUDGE_SETTINGS.confidence))
const saving = ref(false)

const confidenceError = computed(() => judgeConfidenceError(confidence.value))
const dirty = computed(() => !!saved.value && (
  enabled.value !== saved.value.enabled
  || workstreams.value !== saved.value.smartApprovals.workstreams
  || chat.value !== saved.value.smartApprovals.chat
  || Number(confidence.value) !== saved.value.confidence
))
const canSave = computed(() => dirty.value && !confidenceError.value && !saving.value)

function load(j: JudgeSettings) {
  saved.value = j
  enabled.value = j.enabled
  workstreams.value = j.smartApprovals.workstreams
  chat.value = j.smartApprovals.chat
  confidence.value = String(j.confidence)
}

function errText(e: unknown): string | undefined {
  const err = e as { data?: { statusMessage?: string, data?: string }, message?: string }
  return err.data?.data ?? err.data?.statusMessage ?? err.message
}

onMounted(async () => {
  try {
    load((await $fetch<{ judge: JudgeSettings }>('/api/settings/agent-settings')).judge)
  } catch (e) {
    toast.add({ color: 'error', title: 'Could not load the judge settings', description: errText(e) })
  }
})

async function save() {
  if (!canSave.value) return
  saving.value = true
  try {
    const res = await $fetch<{ judge: JudgeSettings }>('/api/settings/agent-settings', {
      method: 'PUT',
      body: { judge: { enabled: enabled.value, smartApprovals: { workstreams: workstreams.value, chat: chat.value }, confidence: Number(confidence.value) } }
    })
    load(res.judge)
    toast.add({ color: 'success', title: 'Judge settings saved' })
  } catch (e) {
    toast.add({ color: 'error', title: 'Could not save the judge settings', description: errText(e) })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    class="flex flex-col gap-4"
    data-testid="judge-settings"
  >
    <div>
      <h2 class="text-base font-semibold text-highlighted">
        Judge
      </h2>
      <p class="text-sm text-muted">
        A second model reviews every approval card and shows its verdict. With Smart Approvals on, a
        call it approves with enough confidence runs without asking you. Host commands, risky rule
        matches and outbound calls after reading suspicious content always wait for you.
      </p>
    </div>
    <USwitch
      v-model="enabled"
      label="Judge approval cards"
      description="Off: no verdicts and no Smart Approvals."
      :disabled="!saved"
      data-testid="judge-enabled"
    />
    <USwitch
      v-model="workstreams"
      label="Smart Approvals for workstreams"
      description="Background workstreams run approved calls without waiting for you."
      :disabled="!saved || !enabled"
      data-testid="judge-smart-workstreams"
    />
    <USwitch
      v-model="chat"
      label="Smart Approvals for chat"
      description="Calls in a conversation run without a card when the judge approves them."
      :disabled="!saved || !enabled"
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
        v-model="confidence"
        type="number"
        inputmode="decimal"
        :step="0.01"
        :disabled="!saved || !enabled"
        class="w-32"
        data-testid="judge-confidence"
      />
    </UFormField>
    <div>
      <UButton
        label="Save judge settings"
        color="primary"
        :loading="saving"
        :disabled="!canSave"
        data-testid="judge-save"
        @click="save()"
      />
    </div>
  </div>
</template>
