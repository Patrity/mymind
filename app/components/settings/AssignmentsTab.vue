<!-- app/components/settings/AssignmentsTab.vue -->
<script setup lang="ts">
// The draggable list lives in the child AssignmentChain; this tab only owns the
// per-usage add/remove + save.
const config = useAiConfig()
onMounted(() => config.load())

const modelLabel = (id: string) => config.draft.value.models.find(m => m.id === id)?.label ?? id
const modelDim = (id: string) => config.draft.value.models.find(m => m.id === id)?.dim ?? null

// Models selectable for a usage. Embeddings only accepts dim-2560 models.
function options(usage: string) {
  const assigned = new Set(config.draft.value.assignments[usage] ?? [])
  return config.draft.value.models
    .filter(m => !assigned.has(m.id) && (usage !== 'embeddings' || m.dim === 2560))
    .map(m => ({ label: m.label, value: m.id }))
}
function add(usage: string, id: string) {
  if (!id) return
  config.setAssignment(usage, [...(config.draft.value.assignments[usage] ?? []), id])
}
function remove(usage: string, id: string) {
  config.setAssignment(usage, (config.draft.value.assignments[usage] ?? []).filter(x => x !== id))
}

const picker = reactive<Record<string, string | null>>({})
function pick(usage: string, id: string) {
  add(usage, id)
  picker[usage] = null
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <UFormField
      v-for="usage in config.usages"
      :key="usage"
      :label="usage"
      :help="usage === 'embeddings' ? 'Only 2560-dim models. Order = failover priority.' : 'Drag to set failover priority (first = primary).'"
    >
      <AssignmentChain
        :ids="config.draft.value.assignments[usage] ?? []"
        :label-of="modelLabel"
        :dim-of="modelDim"
        @reorder="(ids: string[]) => config.setAssignment(usage, ids)"
        @remove="(id: string) => remove(usage, id)"
      />
      <USelectMenu
        :items="options(usage)"
        value-key="value"
        placeholder="Add model…"
        class="mt-2 w-64"
        :model-value="picker[usage] ?? undefined"
        @update:model-value="(id: string) => pick(usage, id)"
      />
    </UFormField>

    <div class="flex items-center gap-3">
      <UButton :loading="config.saving.value" label="Save" @click="config.save()" />
      <UAlert v-if="config.error.value" color="error" :title="config.error.value" />
    </div>
  </div>
</template>
