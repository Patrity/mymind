<!-- app/components/settings/ChannelsTab.vue -->
<script setup lang="ts">
// Settings → Channels (cycle 75): iMessage via BlueBubbles, email via Resend, and the presence
// window that decides when job results also go to the phone. Mirrors ActivityAlertsTab: one draft,
// one Save. The Test buttons use the SAVED settings (the server reads its own config).
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { ChannelsStatus, IMessageTestResult } from '~/composables/useChannelsConfig'

const config = useChannelsConfig()
const toast = useToast()
const queryClient = useQueryClient()

onMounted(async () => {
  try { await config.load() }
  catch (err) { toast.add({ color: 'error', title: 'Could not load channel settings', description: fetchErrorMessage(err) }) }
})

// Shared with the nav dot (same key): the Private API badge falls back to the last health check.
const { data: status } = useQuery({
  queryKey: ['channels', 'status'],
  queryFn: () => $fetch<ChannelsStatus>('/api/channels/status'),
  refetchInterval: 60_000
})

const im = computed(() => config.draft.value?.imessage)
const email = computed(() => config.draft.value?.email)

// ---- password (write-only) ----
const passwordInput = ref('')
function onPassword(v: string | number | null | undefined) {
  const text = v == null ? '' : String(v)
  passwordInput.value = text
  if (!im.value) return
  im.value.password = text ? { password: text } : (im.value.hasPassword ? { keep: true } : null)
}

// ---- default handle: a select over the allowed handles; never an empty-string item value ----
const NO_DEFAULT = '__none__'
const defaultHandleItems = computed(() => [
  { label: 'None', value: NO_DEFAULT },
  ...(im.value?.allowedHandles ?? []).map(h => ({ label: h, value: h }))
])
const defaultHandleModel = computed({
  get: () => im.value?.defaultHandle ?? NO_DEFAULT,
  set: (v: string) => { if (im.value) im.value.defaultHandle = v === NO_DEFAULT ? null : v }
})
// A default handle removed from the allowlist would be rejected on save (400) — drop it.
watch(() => im.value?.allowedHandles, (list) => {
  if (im.value?.defaultHandle && !(list ?? []).includes(im.value.defaultHandle)) im.value.defaultHandle = null
}, { deep: true })

// ---- webhook URL ----
const origin = useRequestURL().origin
const webhookUrl = computed(() => im.value ? `${origin}${im.value.webhookUrlPath}` : '')
const copied = ref(false)
async function copyWebhook() {
  try {
    await navigator.clipboard.writeText(webhookUrl.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch {
    toast.add({ color: 'error', title: 'Copy failed', description: 'The browser blocked clipboard access.' })
  }
}
const regenOpen = ref(false)
const regenerating = ref(false)
async function regenerate() {
  regenerating.value = true
  try {
    await config.regenerateToken()
    regenOpen.value = false
    toast.add({ color: 'success', title: 'Webhook URL regenerated', description: 'Paste the new URL into BlueBubbles — the old one no longer works.' })
  } catch (err) {
    toast.add({ color: 'error', title: 'Could not regenerate', description: fetchErrorMessage(err) })
  } finally { regenerating.value = false }
}

// ---- tests ----
const testResult = ref<IMessageTestResult | null>(null)
const testing = ref<'connection' | 'message' | 'email' | null>(null)
const privateApi = computed(() => testResult.value?.privateApi
  ?? (status.value?.imessage.enabled && status.value.imessage.ok ? status.value.imessage.privateApi : null))

async function testIMessage(send: boolean) {
  testing.value = send ? 'message' : 'connection'
  try {
    testResult.value = await config.testIMessage(send)
    toast.add(send
      ? { color: 'success', title: 'Test message queued', description: 'Sending "Test from MyMind ✅" to the default handle.' }
      : { color: 'success', title: 'BlueBubbles answered', description: `Server ${testResult.value.serverVersion || '(unknown version)'}${testResult.value.detectedIcloud ? ` · ${testResult.value.detectedIcloud}` : ''}` })
  } catch (err) {
    testResult.value = null
    toast.add({ color: 'error', title: send ? 'Test message failed' : 'Connection failed', description: fetchErrorMessage(err) })
  } finally {
    testing.value = null
    // The test forced a health check: bring the nav dot (and the badge fallback) up to date.
    await queryClient.invalidateQueries({ queryKey: ['channels', 'status'] })
  }
}

async function testEmail() {
  testing.value = 'email'
  try {
    await config.testEmail()
    toast.add({ color: 'success', title: 'Test email queued', description: `Sending "Bridget · test" to ${email.value?.to}.` })
  } catch (err) {
    toast.add({ color: 'error', title: 'Test email failed', description: fetchErrorMessage(err) })
  } finally { testing.value = null }
}

// ---- save ----
async function save() {
  try {
    await config.save()
    passwordInput.value = ''
    await queryClient.invalidateQueries({ queryKey: ['channels', 'status'] })
    toast.add({ color: 'success', title: 'Channels saved' })
  } catch (err) {
    toast.add({ color: 'error', title: 'Could not save', description: fetchErrorMessage(err) })
  }
}
</script>

<template>
  <div v-if="config.draft.value && im && email" class="flex flex-col gap-6">
    <div>
      <h2 class="text-base font-semibold text-highlighted">iMessage (BlueBubbles)</h2>
      <p class="text-sm text-muted">Text Bridget from your phone; she answers there.</p>
      <div class="mt-3 flex flex-col gap-3">
        <USwitch v-model="im.enabled" label="Enabled" />
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <UFormField label="Server URL">
            <UInput v-model="im.serverUrl" placeholder="http://mac.local:1234" class="w-full" />
          </UFormField>
          <UFormField label="Password" :help="im.hasPassword ? 'A password is set. Type to replace.' : 'Required.'">
            <UInput :model-value="passwordInput" type="password" autocomplete="new-password" class="w-full" @update:model-value="onPassword" />
          </UFormField>
          <UFormField label="Allowed handles" help="Only these phone numbers / Apple IDs can reach Bridget. Enter to add.">
            <UInputTags v-model="im.allowedHandles" placeholder="+15551234567" class="w-full" />
          </UFormField>
          <UFormField label="Default handle" help="Where proactive messages (jobs, send_message) go.">
            <USelect v-model="defaultHandleModel" :items="defaultHandleItems" value-key="value" class="w-full" />
          </UFormField>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <UButton label="Test connection" icon="i-lucide-plug" color="neutral" variant="outline" :loading="testing === 'connection'" :disabled="testing !== null" @click="testIMessage(false)" />
          <UButton label="Send test message" icon="i-lucide-send" color="neutral" variant="outline" :loading="testing === 'message'" :disabled="testing !== null" @click="testIMessage(true)" />
          <UBadge v-if="privateApi === true" color="success" variant="subtle" icon="i-lucide-check" label="Private API on" />
          <UBadge v-else-if="privateApi === false" color="warning" variant="subtle" icon="i-lucide-triangle-alert" label="Private API off" />
          <span class="text-xs text-dimmed">Tests use the saved settings.</span>
        </div>

        <UFormField label="Webhook URL" help="In BlueBubbles: Settings → API & Webhooks → add this URL, events: New Messages, Message Updates.">
          <div class="flex gap-2">
            <UInput :model-value="webhookUrl" readonly class="flex-1 font-mono" aria-label="Webhook URL" />
            <UButton :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'" color="neutral" variant="outline" :aria-label="copied ? 'Copied' : 'Copy webhook URL'" @click="copyWebhook" />
            <UButton label="Regenerate" icon="i-lucide-refresh-cw" color="neutral" variant="outline" @click="regenOpen = true" />
          </div>
        </UFormField>
      </div>
    </div>

    <div>
      <h2 class="text-base font-semibold text-highlighted">Email</h2>
      <p class="text-sm text-muted">
        Uses the Resend key and sender from <ULink to="/settings/alerts" class="text-primary">Activity &amp; Alerts</ULink>.
        <span v-if="!email.resendReady" class="text-warning">Set them up there first.</span>
      </p>
      <div class="mt-3 flex flex-col gap-3">
        <USwitch v-model="email.enabled" label="Enabled" :disabled="!email.resendReady" />
        <div class="flex flex-wrap items-end gap-2">
          <UFormField label="Send to" class="min-w-64">
            <UInput :model-value="email.to ?? undefined" type="email" placeholder="you@example.com" :disabled="!email.resendReady" class="w-full" @update:model-value="v => email!.to = v ? String(v) : null" />
          </UFormField>
          <UButton label="Send test email" icon="i-lucide-mail" color="neutral" variant="outline" :loading="testing === 'email'" :disabled="!email.resendReady || testing !== null" @click="testEmail" />
        </div>
      </div>
    </div>

    <div>
      <h2 class="text-base font-semibold text-highlighted">Presence</h2>
      <p class="text-sm text-muted">With no activity in the app for this long you count as away, and background job results are texted to you as well.</p>
      <UFormField label="Away after (minutes)" class="mt-3 w-48">
        <UInputNumber v-model="config.draft.value.presenceAwayMinutes" :min="1" :max="240" />
      </UFormField>
    </div>

    <div class="flex items-center gap-3 border-t border-default pt-4">
      <UButton label="Save" color="primary" :loading="config.saving.value" @click="save" />
    </div>

    <UModal v-model:open="regenOpen" title="Regenerate webhook URL?">
      <template #body>
        <p class="text-sm text-muted">
          The current URL stops working immediately. Until you paste the new one into BlueBubbles, new
          messages reach Bridget only through the 2-minute catch-up.
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="regenOpen = false" />
          <UButton label="Regenerate" color="error" :loading="regenerating" @click="regenerate" />
        </div>
      </template>
    </UModal>
  </div>
</template>
