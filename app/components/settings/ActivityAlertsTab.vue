<!-- app/components/settings/ActivityAlertsTab.vue -->
<script setup lang="ts">
const config = useObservabilityConfig()
onMounted(() => config.load())
const kinds = ['inbound', 'job', 'model', 'attempt', 'tool'] as const
const severityItems = [{ label: 'Errors only', value: 'error' }, { label: 'Warnings + errors', value: 'warn' }]
</script>

<template>
  <div v-if="config.draft.value" class="flex flex-col gap-6">
    <div>
      <h2 class="text-base font-semibold text-highlighted">Retention</h2>
      <p class="text-sm text-muted">Errors are kept longer than routine activity. A daily job prunes the rest.</p>
      <div class="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <UFormField label="Keep info (days)"><UInputNumber v-model="config.draft.value.retainInfoDays" :min="1" /></UFormField>
        <UFormField label="Keep errors (days)"><UInputNumber v-model="config.draft.value.retainErrorDays" :min="1" /></UFormField>
        <UFormField label="Max rows"><UInputNumber v-model="config.draft.value.maxRows" :min="1000" :step="1000" /></UFormField>
      </div>
    </div>

    <div>
      <h2 class="text-base font-semibold text-highlighted">Capture</h2>
      <p class="text-sm text-muted">Silence a noisy source without losing the rest.</p>
      <div class="mt-3 flex flex-wrap gap-4">
        <USwitch v-for="k in kinds" :key="k" v-model="config.draft.value.capture[k]" :label="k" />
      </div>
    </div>

    <div>
      <h2 class="text-base font-semibold text-highlighted">Alerts</h2>
      <div class="mt-3 flex flex-col gap-3">
        <USwitch v-model="config.draft.value.alerts.badge" label="Sidebar error badge" />
        <USwitch v-model="config.draft.value.alerts.toast" label="In-app toast on new errors" />
        <USwitch v-model="config.draft.value.alerts.email.enabled" label="Email me (Resend)" />
        <div v-if="config.draft.value.alerts.email.enabled" class="grid grid-cols-1 sm:grid-cols-2 gap-3 border-l-2 border-default pl-4">
          <UFormField label="Recipient"><UInput :model-value="config.draft.value.alerts.email.recipient ?? undefined" type="email" placeholder="you@example.com" @update:model-value="v => config.draft.value!.alerts.email.recipient = v ?? null" /></UFormField>
          <UFormField label="From"><UInput :model-value="config.draft.value.alerts.email.from ?? undefined" type="email" placeholder="mymind@yourdomain" @update:model-value="v => config.draft.value!.alerts.email.from = v ?? null" /></UFormField>
          <UFormField label="Resend API key" :help="config.draft.value.alerts.email.hasKey ? 'A key is set. Type to replace.' : 'Required to send.'">
            <UInput type="password" placeholder="re_…" @update:model-value="v => config.draft.value!.alerts.email.key = v ? { apiKey: String(v) } : { keep: true }" />
          </UFormField>
          <UFormField label="Threshold"><USelect v-model="config.draft.value.alerts.email.minSeverity" :items="severityItems" value-key="value" /></UFormField>
          <UFormField label="Digest window (min)"><UInputNumber v-model="config.draft.value.alerts.email.digestWindowMin" :min="1" /></UFormField>
        </div>
      </div>
    </div>

    <div class="flex items-center gap-3 border-t border-default pt-4">
      <UButton label="Save" color="primary" :loading="config.saving.value" @click="config.save()" />
      <UAlert v-if="config.error.value" color="error" icon="i-lucide-alert-circle" :title="config.error.value" class="flex-1" />
    </div>
  </div>
</template>
