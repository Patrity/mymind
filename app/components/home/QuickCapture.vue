<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import type { DocumentDTO } from '~~/shared/types/documents'

const text = ref('')
const saving = ref(false)
const toast = useToast()
const qc = useQueryClient()

async function capture() {
  const body = text.value.trim()
  if (!body || saving.value) return
  saving.value = true
  try {
    const doc = await $fetch<DocumentDTO>('/api/capture/note', {
      method: 'POST',
      body: { text: body }
    })
    text.value = ''
    toast.add({ color: 'success', title: 'Captured', description: doc.path })
    // The server publishes a `document` change, which debounce-invalidates ['home'].
    // Invalidate directly too so the row appears immediately for the acting tab.
    await qc.invalidateQueries({ queryKey: ['home'] })
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Capture failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UCard>
    <UTextarea
      v-model="text"
      :rows="2"
      autoresize
      placeholder="Write a note…"
      aria-label="Write a note…"
      class="w-full"
      @keydown.meta.enter="capture"
      @keydown.ctrl.enter="capture"
    />
    <div class="flex items-center justify-between mt-2">
      <span class="text-xs text-dimmed">⌘↵ to capture</span>
      <UButton
        size="xs"
        color="primary"
        icon="i-lucide-zap"
        label="Capture"
        :loading="saving"
        :disabled="!text.trim()"
        @click="capture"
      />
    </div>
  </UCard>
</template>
