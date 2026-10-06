<!-- app/components/settings/ConnectionsTab.vue -->
<script setup lang="ts">
// Settings → Connections (cycle 79): linked Google accounts Bridget's gmail/calendar/contacts tools
// act through. Live: reads ['connection','list'], which every `connection` event invalidates.
// Connect/Reconnect go through better-auth's linkSocial (session-gated; Google is never a login).
import type { DropdownMenuItem } from '@nuxt/ui'
import { GOOGLE_SCOPES } from '~~/shared/utils/google-scopes'
import { authClient } from '~/lib/auth-client'
import type { ConnectionDTO } from '~/composables/useConnections'

const toast = useToast()
const route = useRoute()
const { data, error, isPending, refetch } = useConnectionsList()
const configured = computed(() => data.value?.configured ?? false)
const items = computed(() => data.value?.connections ?? [])

watch(error, (err) => {
  if (err) toast.add({ color: 'error', title: 'Could not load connections', description: fetchErrorMessage(err) })
})

// better-auth redirects back here with ?error=… when the link fails (e.g. the Google account is
// already linked to another user, or consent was cancelled).
onMounted(() => {
  const err = route.query.error
  if (typeof err === 'string' && err) toast.add({ color: 'error', title: 'Google link failed', description: err.replace(/_/g, ' ') })
})

// ---- scopes → short service badges ----
const SERVICES = [
  { name: 'gmail', match: (s: string) => s.includes('/auth/gmail.') },
  { name: 'calendar', match: (s: string) => s.includes('/auth/calendar') },
  { name: 'contacts', match: (s: string) => s.includes('/auth/contacts') }
] as const
const services = (c: ConnectionDTO) => SERVICES.map(s => ({ name: s.name, granted: c.scopes.some(s.match) }))

// ---- connect / reconnect ----
const linking = ref(false)
async function link() {
  linking.value = true
  try {
    const res = await authClient.linkSocial({ provider: 'google', scopes: GOOGLE_SCOPES, callbackURL: '/settings/connections' })
    if (res?.error) throw new Error(res.error.message ?? res.error.statusText ?? 'Link failed')
    // On success the browser is redirected to Google; nothing else to do here.
  } catch (err) {
    linking.value = false
    toast.add({ color: 'error', title: 'Could not start Google sign-in', description: (err as Error).message })
  }
}

// ---- label (save on blur) ----
const drafts = reactive<Record<string, string>>({})
watch(items, (list) => {
  for (const c of list) if (!(c.id in drafts)) drafts[c.id] = c.label
}, { immediate: true })
async function saveLabel(c: ConnectionDTO) {
  const next = (drafts[c.id] ?? '').trim()
  if (next === c.label) return
  try {
    await renameConnection(c.id, next)
    drafts[c.id] = next
    toast.add({ color: 'success', title: 'Label saved', description: `Bridget now calls this account "${next}".` })
  } catch (err) {
    drafts[c.id] = c.label
    toast.add({ color: 'error', title: 'Could not rename', description: fetchErrorMessage(err) })
  }
  await refetch()
}

// ---- disconnect (modal confirm) ----
const pendingDisconnect = ref<ConnectionDTO | null>(null)
const disconnectOpen = computed({
  get: () => pendingDisconnect.value !== null,
  set: (v: boolean) => { if (!v) pendingDisconnect.value = null }
})
const disconnecting = ref(false)
async function disconnect() {
  const c = pendingDisconnect.value
  if (!c) return
  disconnecting.value = true
  try {
    const res = await disconnectConnection(c.id)
    delete drafts[c.id]
    toast.add(res.revoked
      ? { color: 'success', title: 'Disconnected', description: `${c.email} was removed and its access revoked at Google.` }
      : { color: 'warning', title: 'Disconnected locally', description: `${c.email} was removed, but Google did not confirm the revoke — remove MyMind at myaccount.google.com → Security → Third-party access.` })
    pendingDisconnect.value = null
  } catch (err) {
    toast.add({ color: 'error', title: 'Could not disconnect', description: fetchErrorMessage(err) })
  } finally {
    disconnecting.value = false
    await refetch()
  }
}

const menuItems = (c: ConnectionDTO): DropdownMenuItem[] => [
  { label: 'Reconnect', icon: 'i-lucide-refresh-cw', onSelect: () => { void link() } },
  { label: 'Disconnect', icon: 'i-lucide-unplug', color: 'error', onSelect: () => { pendingDisconnect.value = c } }
]

const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString() : 'never'
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h2 class="text-base font-semibold text-highlighted">Google accounts</h2>
      <p class="text-sm text-muted">
        Bridget reads and drafts mail, checks your calendar and looks up contacts through these accounts.
        Each label is the name she uses for the account.
      </p>
    </div>

    <UAlert
      v-if="data && !configured"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Google is not configured on this server — see DEPLOYMENT.md (Google connections)"
      description="Set NUXT_GOOGLE_CLIENT_ID and NUXT_GOOGLE_CLIENT_SECRET and restart to enable linking."
    />

    <div v-if="isPending" class="text-sm text-muted">Loading…</div>

    <p v-else-if="data && !items.length && configured" class="text-sm text-muted">
      No Google account connected yet.
    </p>

    <UCard v-for="c in items" :key="c.id" :data-testid="`connection-${c.id}`">
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <UIcon name="i-lucide-mail" class="size-5 text-muted shrink-0" />
            <span class="font-medium text-highlighted truncate">{{ c.email }}</span>
            <UBadge v-if="c.status === 'ok'" color="success" variant="subtle" icon="i-lucide-check" label="Connected" />
            <UBadge v-else color="warning" variant="subtle" icon="i-lucide-triangle-alert" label="Needs reconnect" />
          </div>
          <div class="flex items-center gap-2">
            <UButton
              v-if="c.status === 'needs_reconnect'"
              label="Reconnect"
              icon="i-lucide-refresh-cw"
              color="warning"
              :loading="linking"
              :disabled="!configured"
              @click="link"
            />
            <UButton label="Disconnect" icon="i-lucide-unplug" color="neutral" variant="outline" @click="pendingDisconnect = c" />
            <UDropdownMenu :items="menuItems(c)" :content="{ align: 'end' }">
              <UButton icon="i-lucide-ellipsis-vertical" color="neutral" variant="ghost" aria-label="More actions" />
            </UDropdownMenu>
          </div>
        </div>

        <UAlert
          v-if="c.status === 'needs_reconnect' && c.lastError"
          color="warning"
          variant="soft"
          :description="c.lastError"
        />

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <UFormField label="Label" help="Lowercase letters, digits and hyphens. Saved when you leave the field.">
            <UInput
              v-model="drafts[c.id]"
              class="w-full font-mono"
              :aria-label="`Label for ${c.email}`"
              @blur="saveLabel(c)"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
            />
          </UFormField>
          <div class="flex flex-col gap-1">
            <div class="flex flex-wrap gap-1">
              <UBadge
                v-for="s in services(c)"
                :key="s.name"
                :color="s.granted ? 'neutral' : 'warning'"
                :variant="s.granted ? 'subtle' : 'outline'"
                :icon="s.granted ? undefined : 'i-lucide-circle-slash'"
                :label="s.name"
              />
            </div>
            <span class="text-xs text-dimmed">Last used: {{ fmt(c.lastUsedAt) }}</span>
          </div>
        </div>
      </div>
    </UCard>

    <div v-if="configured" class="flex items-center gap-3 border-t border-default pt-4">
      <UButton label="Connect Google account" icon="i-lucide-plus" color="primary" :loading="linking" @click="link" />
      <span class="text-xs text-dimmed">Opens Google's consent screen; grant every permission.</span>
    </div>

    <UModal v-model:open="disconnectOpen" title="Disconnect Google account?">
      <template #body>
        <p class="text-sm text-muted">
          MyMind's access to <span class="font-medium text-highlighted">{{ pendingDisconnect?.email }}</span> is revoked at Google
          and the account is removed. Bridget can no longer read its mail, calendar or contacts until you connect it again.
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="pendingDisconnect = null" />
          <UButton label="Disconnect" color="error" :loading="disconnecting" @click="disconnect" />
        </div>
      </template>
    </UModal>
  </div>
</template>
