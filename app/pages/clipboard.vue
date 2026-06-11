<script setup lang="ts">
// Clipboard page. Single active thread: list threads; if none, create one.
// Renders the Thread (message history + live stream) and Composer (input).
// Device registration is ensured on mount so the clip_device cookie exists
// before any message is sent.
definePageMeta({ title: 'Clipboard' })

interface ThreadRow {
  id: string
  title: string | null
  createdAt: string
}

const toast = useToast()
const { ensureRegistered } = useClipDevice()

// Ensure device is registered on the client before rendering composer.
onMounted(() => {
  void ensureRegistered()
})

// Resolve or create the default thread. server:false so auth cookies are
// present when the fetch runs (same pattern used throughout MyMind pages).
const threadId = ref<string | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

async function resolveThread() {
  loading.value = true
  error.value = null
  try {
    const threads = await $fetch<ThreadRow[]>('/api/clipboard/threads')
    if (threads.length > 0) {
      threadId.value = threads[0]!.id
    } else {
      // Create a default thread on first visit.
      const created = await $fetch<ThreadRow>('/api/clipboard/threads', {
        method: 'POST',
        body: { title: 'My Clipboard' }
      })
      threadId.value = created.id
    }
  } catch (e) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    error.value = err.data?.statusMessage ?? err.message ?? 'Failed to load clipboard'
    toast.add({ title: 'Clipboard error', description: error.value ?? undefined, color: 'error' })
  } finally {
    loading.value = false
  }
}

// Under SPA (global ssr:false) there is no server pass, so resolveThread can run
// at top level — auth cookies are always present when this executes in the browser.
await resolveThread()
</script>

<template>
  <UDashboardPanel grow :ui="{ body: '!p-0 !overflow-hidden' }">
    <template #header>
      <UDashboardNavbar title="Clipboard">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- Loading state -->
      <div
        v-if="loading"
        class="flex-1 flex items-center justify-center text-muted"
      >
        <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin" />
      </div>

      <!-- Error state -->
      <div
        v-else-if="error"
        class="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8"
      >
        <UIcon name="i-lucide-alert-triangle" class="size-8 text-error" />
        <p class="text-sm text-muted">{{ error }}</p>
        <UButton size="sm" label="Retry" icon="i-lucide-refresh-cw" @click="resolveThread" />
      </div>

      <!-- Main clipboard UI: thread scrolls, composer pinned -->
      <div v-else-if="threadId" class="flex flex-col h-full min-h-0">
        <ClipboardThread :thread-id="threadId" class="flex-1 min-h-0" />
        <ClipboardComposer :thread-id="threadId" class="shrink-0" />
      </div>
    </template>
  </UDashboardPanel>
</template>
