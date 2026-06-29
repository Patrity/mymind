<!-- app/components/voice/Composer.vue -->
<script setup lang="ts">
import type { TranscriptEntry } from '~/composables/useVoice'
import type { AttachmentRef } from '~~/shared/types/conversation'

const props = defineProps<{
  entries: TranscriptEntry[]
  // Typed turns go over the voice WS only. sendText auto-connects the WS
  // transparently, so the composer is always usable — no explicit Connect step.
  sendText?: (t: string, speak?: boolean, attachments?: AttachmentRef[]) => boolean | Promise<boolean>
  /** When true, typed sends request a spoken reply from the agent. */
  speak?: boolean
}>()

const toast = useToast()
const text = ref('')
const pending = ref<File[]>([])
const uploading = ref(false)
const dragging = ref(false)

// Track object URLs so we can revoke them on remove / after send
const objectUrls = ref<Map<File, string>>(new Map())

const MAX_FILES = 4
const MAX_SIZE = 20 * 1024 * 1024 // 20 MB

const ALLOWED_MIME_PREFIXES = ['image/', 'text/']
const ALLOWED_MIME_EXACT = new Set([
  'application/pdf',
  'application/json',
  'application/xml',
  'application/csv',
])

function isAllowedType(file: File): boolean {
  return (
    ALLOWED_MIME_PREFIXES.some(prefix => file.type.startsWith(prefix)) ||
    ALLOWED_MIME_EXACT.has(file.type)
  )
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function thumbnailFor(file: File): string | null {
  if (!file.type.startsWith('image/')) return null
  if (objectUrls.value.has(file)) return objectUrls.value.get(file)!
  const url = URL.createObjectURL(file)
  objectUrls.value.set(file, url)
  return url
}

function addFiles(files: FileList | File[]) {
  const candidates = Array.from(files)
  for (const file of candidates) {
    if (!isAllowedType(file)) {
      toast.add({ title: 'Unsupported file type', description: `${file.name}: Only images, PDFs, and text files are supported.`, color: 'error' })
      continue
    }
    if (file.size > MAX_SIZE) {
      toast.add({ title: 'File too large', description: `${file.name} exceeds the 20 MB limit.`, color: 'error' })
      continue
    }
    if (pending.value.length >= MAX_FILES) {
      toast.add({ title: 'Too many attachments', description: `Maximum ${MAX_FILES} attachments per message.`, color: 'error' })
      break
    }
    pending.value.push(file)
  }
}

function removeFile(file: File) {
  pending.value = pending.value.filter(f => f !== file)
  const url = objectUrls.value.get(file)
  if (url) {
    URL.revokeObjectURL(url)
    objectUrls.value.delete(file)
  }
}

function revokeAllUrls() {
  for (const url of objectUrls.value.values()) {
    URL.revokeObjectURL(url)
  }
  objectUrls.value.clear()
}

// File picker
const fileInput = ref<HTMLInputElement | null>(null)
function pickFile() {
  fileInput.value?.click()
}
function onFileChosen(e: Event) {
  const target = e.target as HTMLInputElement
  if (target.files?.length) addFiles(target.files)
  target.value = ''
}

// Paste
function onPaste(e: ClipboardEvent) {
  if (!e.clipboardData) return
  const items = Array.from(e.clipboardData.items)
  const fileItems = items.filter(i => i.kind === 'file')
  if (fileItems.length) {
    e.preventDefault()
    const files = fileItems.map(i => i.getAsFile()).filter((f): f is File => f !== null)
    addFiles(files)
  }
  // Text paste falls through to UInput's default handler
}

// Drag-drop
function onDrop(e: DragEvent) {
  dragging.value = false
  const files = e.dataTransfer?.files
  if (files?.length) addFiles(files)
}

// Upload + send
async function uploadOne(file: File): Promise<AttachmentRef> {
  const form = new FormData()
  form.append('file', file)
  if (file.type.startsWith('image/')) {
    const r = await $fetch<{ id: string }>('/api/upload', { method: 'POST', body: form })
    return { id: r.id, kind: 'image', mime: file.type, name: file.name }
  }
  else {
    const r = await $fetch<{ id: string; kind: 'file'; mime: string; name?: string }>('/api/agent/files', { method: 'POST', body: form })
    return { id: r.id, kind: 'file', mime: r.mime, name: r.name ?? file.name }
  }
}

async function send() {
  const q = text.value.trim()
  if (!q && !pending.value.length) return
  if (uploading.value) return

  let attachments: AttachmentRef[] = []
  if (pending.value.length) {
    uploading.value = true
    try {
      attachments = await Promise.all(pending.value.map(uploadOne))
    }
    catch {
      toast.add({ title: 'Upload failed', description: 'Could not upload an attachment. Try again.', color: 'error' })
      uploading.value = false
      return // keep the tray so the user can retry
    }
    uploading.value = false
  }

  text.value = ''
  pending.value = []
  revokeAllUrls()

  // WS path only: the server echoes the user transcript and streams the reply
  // (text + audio + states) over the WS — nothing to await or append here.
  await props.sendText?.(q, props.speak ?? false, attachments)
}
</script>

<template>
  <div
    class="border-t border-default relative"
    :class="dragging ? 'bg-primary/5' : ''"
    @dragover.prevent="dragging = true"
    @dragleave.prevent="dragging = false"
    @drop.prevent="onDrop"
  >
    <!-- Drop overlay hint -->
    <div
      v-if="dragging"
      class="absolute inset-0 flex items-center justify-center pointer-events-none z-10 text-primary font-medium"
    >
      Drop to attach
    </div>

    <!-- Attachment chip tray -->
    <div
      v-if="pending.length"
      class="flex flex-wrap gap-2 px-3 pt-3"
    >
      <div
        v-for="file in pending"
        :key="file.name + file.size"
        class="flex items-center gap-1.5 rounded-md border border-default bg-elevated px-2 py-1 text-sm"
      >
        <!-- Image thumbnail -->
        <img
          v-if="file.type.startsWith('image/')"
          :src="thumbnailFor(file)!"
          class="h-8 w-8 rounded object-cover"
          :alt="file.name"
        >
        <!-- Non-image icon -->
        <UIcon
          v-else
          name="i-lucide-file"
          class="text-muted shrink-0"
        />
        <span class="max-w-32 truncate text-default">{{ file.name }}</span>
        <span class="text-muted text-xs whitespace-nowrap">{{ humanSize(file.size) }}</span>
        <UButton
          icon="i-lucide-x"
          size="xs"
          variant="ghost"
          color="neutral"
          class="shrink-0"
          @click="removeFile(file)"
        />
      </div>
    </div>

    <!-- Input row -->
    <form
      class="flex items-center gap-2 p-3"
      @submit.prevent="send"
    >
      <!-- Paperclip file picker -->
      <UButton
        icon="i-lucide-paperclip"
        size="sm"
        variant="ghost"
        color="neutral"
        type="button"
        @click="pickFile"
      />
      <input
        ref="fileInput"
        type="file"
        multiple
        class="hidden"
        @change="onFileChosen"
      >

      <UInput
        v-model="text"
        placeholder="Type a message…"
        class="flex-1"
        @paste="onPaste"
      />

      <UButton
        type="submit"
        icon="i-lucide-send"
        :disabled="(!text.trim() && !pending.length) || uploading"
        :loading="uploading"
      />
    </form>
  </div>
</template>
