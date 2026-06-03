<script setup lang="ts">
// Bottom-of-thread input. Three entry paths into a thread:
//   1. Type + Send (or ⌘↵): plain markdown POST to /messages.
//   2. Paste rich content: captures `text/html` alongside `text/plain` so the
//      original formatting round-trips through copyRich. If a *file* is on
//      the clipboard (typical screenshot paste), we route to the upload path
//      instead and skip the text channel entirely.
//   3. Drag-drop files: multipart upload per file. The whole composer becomes
//      a drop zone with a centred overlay hint while a drag is in flight.
//
// Adapted from copipasta: API base → /api/clipboard/*; deviceId read from
// clip_device cookie and sent in the message body.
const props = defineProps<{ threadId: string }>()
const toast = useToast()

const text = ref('')
const html = ref<string | null>(null)
const submitting = ref(false)
const dragging = ref(false)

const currentDeviceId = useCookie<string | null>('clip_device')

async function send() {
  const body = text.value.trim()
  if (!body || submitting.value) return
  submitting.value = true
  try {
    await $fetch(`/api/clipboard/threads/${props.threadId}/messages`, {
      method: 'POST',
      body: {
        bodyText: body,
        bodyHtml: html.value ?? undefined,
        deviceId: currentDeviceId.value ?? undefined
      }
    })
    text.value = ''
    html.value = null
  } catch (e) {
    const err = e as { data?: { statusMessage?: string, error?: { message?: string } } }
    toast.add({
      title: 'Could not send',
      description: err?.data?.statusMessage ?? err?.data?.error?.message,
      color: 'error'
    })
  } finally {
    submitting.value = false
  }
}

function onPaste(e: ClipboardEvent) {
  if (!e.clipboardData) return
  // Screenshot / image-on-clipboard path: short-circuit straight to upload.
  const items = Array.from(e.clipboardData.items)
  const fileItem = items.find(i => i.kind === 'file')
  if (fileItem) {
    const file = fileItem.getAsFile()
    if (file) {
      e.preventDefault()
      uploadFile(file)
      return
    }
  }
  // Text path. If the source provided HTML, capture both representations and
  // suppress the default insert so the textarea shows the plain version while
  // we hold onto the rich one for send.
  const pastedText = e.clipboardData.getData('text/plain')
  const pastedHtml = e.clipboardData.getData('text/html')
  if (pastedHtml) {
    e.preventDefault()
    text.value = (text.value + pastedText).slice(0, 2_000_000)
    html.value = pastedHtml
  } else {
    // Pure plain-text paste — let the textarea handle it natively and drop any
    // stale html from a previous paste in the same composition.
    html.value = null
  }
}

async function uploadFile(file: File) {
  const form = new FormData()
  form.append('file', file)
  submitting.value = true
  try {
    await $fetch(`/api/clipboard/threads/${props.threadId}/upload`, { method: 'POST', body: form })
    toast.add({ title: `Uploaded ${file.name}` })
  } catch (e) {
    const err = e as { data?: { statusMessage?: string, error?: { message?: string } } }
    toast.add({
      title: `Upload failed: ${file.name}`,
      description: err?.data?.statusMessage ?? err?.data?.error?.message,
      color: 'error'
    })
  } finally {
    submitting.value = false
  }
}

function onDrop(e: DragEvent) {
  dragging.value = false
  const files = e.dataTransfer?.files
  if (!files?.length) return
  Array.from(files).forEach(uploadFile)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    send()
  }
}

const fileInput = ref<HTMLInputElement | null>(null)
function pickFile() {
  fileInput.value?.click()
}
function onFileChosen(e: Event) {
  const target = e.target as HTMLInputElement
  const files = target.files
  if (!files?.length) return
  Array.from(files).forEach(uploadFile)
  target.value = ''
}
</script>

<template>
  <div
    class="border-t border-default p-3 relative"
    :class="dragging ? 'bg-primary/5' : ''"
    @dragover.prevent="dragging = true"
    @dragleave.prevent="dragging = false"
    @drop.prevent="onDrop"
  >
    <div
      v-if="dragging"
      class="absolute inset-0 flex items-center justify-center pointer-events-none z-10 text-primary font-medium"
    >
      Drop to upload
    </div>
    <div class="flex gap-2 items-end">
      <UButton
        icon="i-lucide-paperclip"
        size="sm"
        variant="ghost"
        color="neutral"
        @click="pickFile"
      />
      <input
        ref="fileInput"
        type="file"
        multiple
        class="hidden"
        @change="onFileChosen"
      >
      <UTextarea
        v-model="text"
        autofocus
        placeholder="Paste or type… ⌘↵ to send"
        :rows="2"
        :maxrows="10"
        autoresize
        class="flex-1"
        @paste="onPaste"
        @keydown="onKeydown"
      />
      <UButton
        :loading="submitting"
        :disabled="!text.trim()"
        icon="i-lucide-send"
        size="sm"
        label="Send"
        @click="send"
      />
    </div>
    <p
      v-if="html"
      class="text-xs text-muted mt-1"
    >
      Formatted content will be preserved
    </p>
  </div>
</template>
