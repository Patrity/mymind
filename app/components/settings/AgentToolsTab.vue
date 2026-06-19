<!-- app/components/settings/AgentToolsTab.vue -->
<script setup lang="ts">
interface Approval { id: string; pattern: string; tool: string; createdAt: string; lastUsedAt: string | null }
const toast = useToast()
const rows = ref<Approval[]>([])
const newPattern = ref('')
const saving = ref(false)
const error = ref('')

async function load() { rows.value = await $fetch<Approval[]>('/api/settings/exec-approvals') }
onMounted(load)

async function add() {
  const pattern = newPattern.value.trim()
  if (!pattern) return
  saving.value = true; error.value = ''
  try {
    await $fetch('/api/settings/exec-approvals', { method: 'PUT', body: { pattern } })
    newPattern.value = ''
    await load()
    toast.add({ title: 'Pattern added', color: 'success' })
  } catch (e) {
    error.value = (e as { data?: { message?: string } })?.data?.message ?? 'Failed to add pattern'
  } finally { saving.value = false }
}

async function save(row: Approval) {
  try {
    await $fetch('/api/settings/exec-approvals', { method: 'PUT', body: { id: row.id, pattern: row.pattern } })
    toast.add({ title: 'Pattern updated', color: 'success' })
  } catch (e) {
    error.value = (e as { data?: { message?: string } })?.data?.message ?? 'Failed to update'
    await load()
  }
}

async function revoke(row: Approval) {
  await $fetch('/api/settings/exec-approvals', { method: 'DELETE', query: { id: row.id } })
  await load()
  toast.add({ title: 'Pattern revoked', color: 'neutral' })
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h2 class="text-base font-semibold text-highlighted">Agent Tools — Command Allowlist</h2>
      <p class="text-sm text-muted">
        Commands matching these glob patterns run via the <code>exec</code> tool without a per-command prompt.
        <code>*</code> matches a single command's arguments (it never spans <code>;</code>, <code>&amp;&amp;</code>, <code>|</code> or substitutions). Keep patterns specific — a bare <code>*</code> is rejected.
      </p>
    </div>

    <div class="flex items-end gap-3">
      <UFormField label="New pattern" class="flex-1 max-w-md">
        <UInput v-model="newPattern" placeholder="git *" class="w-full" @keydown.enter="add()" />
      </UFormField>
      <UButton label="Add" color="primary" :loading="saving" @click="add()" />
    </div>
    <UAlert v-if="error" color="error" icon="i-lucide-alert-circle" :title="error" />

    <div v-if="rows.length" class="flex flex-col divide-y divide-default border border-default rounded-lg">
      <div v-for="row in rows" :key="row.id" class="flex items-center gap-3 p-3">
        <UInput v-model="row.pattern" class="flex-1 max-w-md font-mono text-sm" @blur="save(row)" @keydown.enter="save(row)" />
        <span class="text-xs text-muted">{{ row.lastUsedAt ? `last used ${new Date(row.lastUsedAt).toLocaleDateString()}` : 'never used' }}</span>
        <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="sm" aria-label="Revoke" @click="revoke(row)" />
      </div>
    </div>
    <p v-else class="text-sm text-muted">No allowlisted patterns yet. Every exec command will prompt for approval.</p>
  </div>
</template>
