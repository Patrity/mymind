<!-- app/components/settings/SecretsTab.vue -->
<script setup lang="ts">
const store = useExecSecrets()
const name = ref('')
const value = ref('')
const saving = ref(false)

onMounted(() => store.load())

async function add() {
  if (!name.value || !value.value) return
  saving.value = true
  try {
    await store.add(name.value, value.value)
    name.value = ''
    value.value = ''
  } finally {
    saving.value = false
  }
}

async function remove(secretName: string) {
  await store.remove(secretName)
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h2 class="text-base font-semibold text-highlighted">
        Environment Secrets
      </h2>
      <p class="text-sm text-muted">
        Secrets are injected as env vars into every agent <code>exec</code> command
        (e.g. <code>GITHUB_TOKEN</code>, <code>CLOUDFLARE_API_TOKEN</code>).
        Stored encrypted; values are never shown again.
      </p>
    </div>

    <div
      v-if="store.secrets.value.length"
      class="flex flex-col divide-y divide-default border border-default rounded-lg"
    >
      <div
        v-for="s in store.secrets.value"
        :key="s.name"
        class="flex items-center gap-3 p-3"
      >
        <code class="flex-1 font-mono text-sm text-highlighted">{{ s.name }}</code>
        <span class="text-sm text-muted font-mono">••••{{ s.lastFour }}</span>
        <UButton
          icon="i-lucide-trash-2"
          color="error"
          variant="ghost"
          size="sm"
          aria-label="Delete secret"
          @click="remove(s.name)"
        />
      </div>
    </div>
    <p
      v-else
      class="text-sm text-muted"
    >
      No secrets stored yet. Add one below.
    </p>

    <div class="flex items-end gap-3">
      <UFormField label="Name">
        <UInput
          v-model="name"
          placeholder="GITHUB_TOKEN"
          class="font-mono"
        />
      </UFormField>
      <UFormField
        label="Value"
        class="flex-1"
      >
        <UInput
          v-model="value"
          type="password"
          placeholder="ghp_…"
          class="w-full"
        />
      </UFormField>
      <UButton
        label="Add"
        color="primary"
        :disabled="!name || !value"
        :loading="saving"
        @click="add()"
      />
    </div>

    <UAlert
      v-if="store.error.value"
      color="error"
      icon="i-lucide-alert-circle"
      :title="store.error.value"
    />
  </div>
</template>
