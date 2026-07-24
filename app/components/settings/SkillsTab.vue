<!-- app/components/settings/SkillsTab.vue -->
<script setup lang="ts">
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query'

interface Skill { id: string; name: string; description: string; whenToUse: string; active: boolean; source: 'human' | 'agent'; body: string; updatedAt: string }

const toast = useToast()
const qc = useQueryClient()
const { data, error } = useQuery<Skill[]>({ queryKey: ['skills', 'list'], queryFn: () => $fetch('/api/skills') })
const skills = computed(() => data.value ?? [])

const { data: cfg } = useQuery<{ enabled: boolean }>({ queryKey: ['skills', 'enabled'], queryFn: () => $fetch('/api/settings/skills-enabled') })

function errorMessage(e: unknown): string {
  const err = e as { data?: { statusMessage?: string }, message?: string }
  return err.data?.statusMessage ?? err.message ?? 'Unknown error'
}

const toggleEnabled = useMutation({
  mutationFn: (enabled: boolean) => $fetch('/api/settings/skills-enabled', { method: 'PUT', body: { enabled } }),
  onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  onError: (e: unknown) => toast.add({ color: 'error', title: 'Could not update kill-switch', description: errorMessage(e) })
})

// NOTE: UModal's v-model:open takes a BOOLEAN — keep it separate from the
// selected row, or the modal silently never opens.
const selected = ref<Skill | null>(null)
const editOpen = ref(false)
const draft = reactive({ description: '', whenToUse: '', body: '' })
function open(s: Skill) {
  selected.value = s
  Object.assign(draft, { description: s.description, whenToUse: s.whenToUse, body: s.body })
  editOpen.value = true
}
function closeEdit() { editOpen.value = false; selected.value = null }

const save = useMutation({
  mutationFn: (s: Skill) => $fetch(`/api/skills/${s.name}`, { method: 'PUT', body: { ...draft } }),
  onSuccess: () => { qc.invalidateQueries({ queryKey: ['skills', 'list'] }); closeEdit() },
  onError: (e: unknown) => toast.add({ color: 'error', title: 'Save failed', description: errorMessage(e) })
})
const setActive = useMutation({
  mutationFn: (p: { name: string; active: boolean }) => $fetch(`/api/skills/${p.name}`, { method: 'PUT', body: { active: p.active } }),
  onSuccess: () => qc.invalidateQueries({ queryKey: ['skills', 'list'] }),
  onError: (e: unknown) => toast.add({ color: 'error', title: 'Could not toggle skill', description: errorMessage(e) })
})
const remove = useMutation({
  mutationFn: (name: string) => $fetch(`/api/skills/${name}`, { method: 'DELETE' }),
  onSuccess: () => { qc.invalidateQueries({ queryKey: ['skills', 'list'] }); closeEdit() },
  onError: (e: unknown) => toast.add({ color: 'error', title: 'Delete failed', description: errorMessage(e) })
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-base font-semibold text-highlighted">
          Agent Skills
        </h2>
        <p class="text-sm text-muted">
          How-to guides the agent loads on demand instead of carrying in every prompt. It can write and revise
          these itself — changes go live immediately and are undoable.
        </p>
      </div>
      <UFormField label="Enabled" class="shrink-0">
        <USwitch :model-value="cfg?.enabled ?? true" @update:model-value="(v: boolean) => toggleEnabled.mutate(v)" />
      </UFormField>
    </div>

    <UAlert v-if="error" color="error" icon="i-lucide-alert-circle" :title="'Could not load skills'" :description="String(error)" />

    <UCard v-for="s in skills" :key="s.id">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-medium truncate">{{ s.name }}</span>
            <UBadge :color="s.source === 'agent' ? 'primary' : 'neutral'" variant="subtle" size="sm">{{ s.source }}</UBadge>
            <UBadge v-if="!s.active" color="warning" variant="subtle" size="sm">inactive</UBadge>
          </div>
          <p class="text-sm text-muted truncate">{{ s.description }}</p>
          <p class="text-xs text-dimmed truncate">{{ s.whenToUse }}</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <USwitch :model-value="s.active" @update:model-value="(v: boolean) => setActive.mutate({ name: s.name, active: v })" />
          <UButton size="xs" variant="subtle" @click="open(s)">
            Edit
          </UButton>
          <UButton size="xs" color="error" variant="ghost" @click="remove.mutate(s.name)">
            Delete
          </UButton>
        </div>
      </div>
    </UCard>

    <p v-if="!skills.length && !error" class="text-sm text-muted">
      No skills yet. Run <code>node_modules/.bin/tsx scripts/seed-skills.ts</code> to install the starter set.
    </p>

    <UModal v-model:open="editOpen" :title="selected?.name">
      <template #content>
        <div v-if="selected" class="p-4 space-y-3">
          <UFormField label="Description"><UInput v-model="draft.description" class="w-full" /></UFormField>
          <UFormField label="When to use"><UInput v-model="draft.whenToUse" class="w-full" /></UFormField>
          <UFormField label="Body (markdown)">
            <div class="h-64 border border-default rounded-md overflow-hidden">
              <CodeEditor v-model="draft.body" language="markdown" />
            </div>
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton variant="ghost" @click="closeEdit()">
              Cancel
            </UButton>
            <UButton :loading="save.isPending.value" @click="save.mutate(selected)">
              Save
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
