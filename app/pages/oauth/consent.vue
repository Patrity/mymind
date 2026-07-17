<script setup lang="ts">
definePageMeta({ layout: false })

const route = useRoute()
const consentCode = computed(() => (route.query.consent_code as string) ?? '')
const clientId = computed(() => (route.query.client_id as string) ?? 'Unknown client')
const scopes = computed(() => ((route.query.scope as string) ?? '').split(' ').filter(Boolean))

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

      <p class="text-default mb-2">
        <span class="font-mono text-sm bg-muted px-1.5 py-0.5 rounded">{{ clientId }}</span>
        is asking to access your MyMind account.
      </p>
      <ul v-if="scopes.length" class="text-sm text-muted list-disc ms-5 mb-2">
        <li v-for="s in scopes" :key="s">{{ s }}</li>
      </ul>
      <p class="text-sm text-dimmed">
        Only approve if you initiated this connection yourself (for example, adding
        MyMind as a connector in Claude).
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
