<!-- app/components/settings/PersonaTab.vue -->
<script setup lang="ts">
const toast = useToast()

const text = ref('')
const saving = ref(false)
const error = ref('')

onMounted(async () => {
  const data = await $fetch('/api/settings/persona')
  text.value = data.text
})

async function save() {
  saving.value = true
  error.value = ''
  try {
    await $fetch('/api/settings/persona', { method: 'PUT', body: { text: text.value } })
    toast.add({ title: 'Persona saved', color: 'success' })
  } catch {
    error.value = 'Failed to save persona'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h2 class="text-base font-semibold text-highlighted">Bridget's Persona</h2>
      <p class="text-sm text-muted">
        This is Bridget's base personality, used by both voice and chat. Live context (date, projects, tasks) and time-of-day tone are added automatically.
      </p>
      <div class="mt-3">
        <UTextarea v-model="text" :rows="14" class="w-full font-mono" />
      </div>
    </div>

    <div class="flex items-center gap-3 border-t border-default pt-4">
      <UButton label="Save" color="primary" :loading="saving" @click="save()" />
      <UAlert v-if="error" color="error" icon="i-lucide-alert-circle" :title="error" class="flex-1" />
    </div>
  </div>
</template>
