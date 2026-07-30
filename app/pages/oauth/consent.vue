<script setup lang="ts">
definePageMeta({ layout: false })

const route = useRoute()
const consentCode = computed(() => (route.query.consent_code as string) ?? '')
const clientId = computed(() => (route.query.client_id as string) ?? '')
const scopes = computed(() => ((route.query.scope as string) ?? '').split(' ').filter(Boolean))

type ClientInfo = {
  clientId: string
  displayName: string
  redirectHosts: string[]
  disabled: boolean
}

// better-auth's authorize redirect only carries client_id + scope, so the human-readable name
// has to be looked up. Client-side only (`server: false`): this is a transient interstitial and
// the lookup is session-gated, which an SSR-time internal fetch would not carry a cookie for.
const { data: client } = await useFetch<ClientInfo>(
  () => `/api/oauth/client/${encodeURIComponent(clientId.value)}`,
  { server: false, immediate: !!clientId.value }
)

// Falls back to the raw client id until the lookup lands (and if it fails outright) — ugly,
// but never misleading. See server/utils/oauth-client.ts for why the name alone isn't trusted.
const displayName = computed(() => client.value?.displayName || clientId.value || 'Unknown client')
const redirectHosts = computed(() => client.value?.redirectHosts ?? [])

const error = ref<string | null>(null)
const loading = ref<'approve' | 'deny' | null>(null)

async function decide(accept: boolean) {
  error.value = null
  loading.value = accept ? 'approve' : 'deny'
  try {
    const res = await $fetch<{ redirectURI: string }>('/api/auth/oauth2/consent', {
      method: 'POST',
      body: { accept, consent_code: consentCode.value }
    })
    window.location.href = res.redirectURI
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Consent request failed'
    loading.value = null
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-default p-4">
    <UCard class="w-full max-w-md">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-brain" class="size-6 text-primary" />
          <span class="font-semibold">Connection request</span>
        </div>
      </template>

      <UAlert
        v-if="error"
        color="error"
        :title="error"
        icon="i-lucide-circle-alert"
        class="mb-4"
      />

      <p class="text-default mb-3">
        <span class="font-semibold text-highlighted">{{ displayName }}</span>
        is asking to access your MyMind account.
      </p>

      <dl class="text-sm space-y-1.5 mb-3">
        <div v-if="redirectHosts.length" class="flex gap-2">
          <dt class="text-muted shrink-0">Sends your sign-in to</dt>
          <dd class="text-highlighted font-medium break-all">{{ redirectHosts.join(', ') }}</dd>
        </div>
        <div v-if="clientId" class="flex gap-2">
          <dt class="text-muted shrink-0">Client ID</dt>
          <dd class="font-mono text-xs text-dimmed break-all">{{ clientId }}</dd>
        </div>
      </dl>

      <template v-if="scopes.length">
        <p class="text-sm text-muted mb-1">Requested access</p>
        <ul class="text-sm text-muted list-disc ms-5 mb-3">
          <li v-for="s in scopes" :key="s">{{ s }}</li>
        </ul>
      </template>

      <p class="text-sm text-dimmed">
        Only approve if you started this yourself — for example, adding MyMind as a
        connector in Claude. Anyone can register a connector under any name, so check the
        destination above is the app you actually expect.
      </p>

      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="soft" :loading="loading === 'deny'" @click="decide(false)">
            Deny
          </UButton>
          <UButton color="primary" :loading="loading === 'approve'" @click="decide(true)">
            Approve
          </UButton>
        </div>
      </template>
    </UCard>
  </div>
</template>
