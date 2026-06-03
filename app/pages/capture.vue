<script setup lang="ts">
import type { DocumentDTO } from '~~/shared/types/documents'
import type { ImageDTO } from '~~/shared/types/images'

definePageMeta({ title: 'Capture' })

const toast = useToast()
const images = useImages()

// ── Note tab ─────────────────────────────────────────────────────────────────
const noteTitle = ref('')
const noteText = ref('')
const noteSaving = ref(false)
const noteCreated = ref<DocumentDTO | null>(null)

async function captureNote() {
  if (!noteText.value.trim()) return
  noteSaving.value = true
  noteCreated.value = null
  try {
    const doc = await $fetch<DocumentDTO>('/api/capture/note', {
      method: 'POST',
      body: { text: noteText.value, title: noteTitle.value || undefined }
    })
    noteCreated.value = doc
    toast.add({ color: 'success', title: 'Note captured', description: doc.path })
    noteTitle.value = ''
    noteText.value = ''
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Capture failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    noteSaving.value = false
  }
}

// ── Image tab ─────────────────────────────────────────────────────────────────
const imageFileInput = ref<HTMLInputElement | null>(null)
const imagePublic = ref(false)
const imageUploading = ref(false)
const imageCreated = ref<ImageDTO | null>(null)

async function onImageSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  imageUploading.value = true
  imageCreated.value = null
  try {
    const img = await images.upload(file, imagePublic.value)
    imageCreated.value = img
    toast.add({ color: 'success', title: 'Image uploaded', description: img.originalName ?? img.id })
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Upload failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    imageUploading.value = false
    if (imageFileInput.value) imageFileInput.value.value = ''
  }
}

// ── Transcribe tab ────────────────────────────────────────────────────────────
const transcribeFileInput = ref<HTMLInputElement | null>(null)
const transcribeTitle = ref('')
const transcribeUploading = ref(false)
const transcribing = ref(false)
const transcribedDoc = ref<DocumentDTO | null>(null)
const transcribedText = ref('')

async function onTranscribeSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  transcribeUploading.value = true
  transcribedDoc.value = null
  transcribedText.value = ''
  try {
    // Step 1: upload image to get id
    const img = await images.upload(file, false)
    toast.add({ color: 'neutral', title: 'Image uploaded', description: 'Transcribing…' })

    // Step 2: transcribe via vision model
    transcribing.value = true
    const result = await $fetch<DocumentDTO & { ocrText: string }>('/api/capture/transcribe', {
      method: 'POST',
      body: {
        imageId: img.id,
        title: transcribeTitle.value || undefined
      }
    })
    transcribedDoc.value = result
    transcribedText.value = result.ocrText ?? ''
    toast.add({ color: 'success', title: 'Transcribed', description: result.path })
    transcribeTitle.value = ''
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Transcription failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    transcribeUploading.value = false
    transcribing.value = false
    if (transcribeFileInput.value) transcribeFileInput.value.value = ''
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
const tabs = [
  { label: 'Note', slot: 'note' as const, icon: 'i-lucide-file-text' },
  { label: 'Image', slot: 'image' as const, icon: 'i-lucide-image' },
  { label: 'Transcribe', slot: 'transcribe' as const, icon: 'i-lucide-scan-text' }
]
</script>

<template>
  <UDashboardPanel
    id="capture"
    grow
    :ui="{ body: '!p-0' }"
  >
    <template #header>
      <UDashboardNavbar title="Capture">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="p-6 max-w-2xl mx-auto">
        <UTabs
          :items="tabs"
          class="w-full"
        >
          <!-- ── Note ── -->
          <template #note>
            <div class="mt-4 space-y-3">
              <UInput
                v-model="noteTitle"
                placeholder="Title (optional)"
                :disabled="noteSaving"
              />
              <UTextarea
                v-model="noteText"
                placeholder="Write your note…"
                :rows="8"
                autoresize
                :disabled="noteSaving"
              />
              <div class="flex items-center justify-between">
                <UButton
                  icon="i-lucide-zap"
                  :loading="noteSaving"
                  :disabled="!noteText.trim()"
                  @click="captureNote"
                >
                  Capture
                </UButton>
                <NuxtLink
                  v-if="noteCreated"
                  to="/documents"
                  class="text-xs text-primary hover:underline"
                >
                  {{ noteCreated.path }} ↗
                </NuxtLink>
              </div>
            </div>
          </template>

          <!-- ── Image ── -->
          <template #image>
            <div class="mt-4 space-y-3">
              <div class="flex items-center gap-3">
                <USwitch
                  v-model="imagePublic"
                  label="Public"
                  size="sm"
                />
              </div>
              <div
                class="border-2 border-dashed border-default rounded-lg p-8 flex flex-col items-center gap-3 text-center"
              >
                <UIcon
                  name="i-lucide-image-plus"
                  class="size-10 text-muted"
                />
                <p class="text-sm text-muted">
                  Pick an image from your device or camera
                </p>
                <UButton
                  icon="i-lucide-upload"
                  variant="soft"
                  :loading="imageUploading"
                  @click="imageFileInput?.click()"
                >
                  Choose file
                </UButton>
              </div>
              <!-- Hidden input — capture="environment" triggers rear camera on mobile -->
              <input
                ref="imageFileInput"
                type="file"
                accept="image/*"
                capture="environment"
                class="hidden"
                @change="onImageSelected"
              >
              <div
                v-if="imageCreated"
                class="flex items-center gap-2 text-xs text-success"
              >
                <UIcon
                  name="i-lucide-check-circle"
                  class="size-4"
                />
                <NuxtLink
                  to="/gallery"
                  class="hover:underline"
                >
                  Uploaded — view in Gallery ↗
                </NuxtLink>
              </div>
            </div>
          </template>

          <!-- ── Transcribe ── -->
          <template #transcribe>
            <div class="mt-4 space-y-3">
              <UInput
                v-model="transcribeTitle"
                placeholder="Document title (optional)"
                :disabled="transcribeUploading || transcribing"
              />
              <div
                class="border-2 border-dashed border-default rounded-lg p-8 flex flex-col items-center gap-3 text-center"
              >
                <UIcon
                  name="i-lucide-scan-text"
                  class="size-10 text-muted"
                />
                <p class="text-sm text-muted">
                  Upload a photo of handwriting or printed text
                </p>
                <UButton
                  icon="i-lucide-camera"
                  variant="soft"
                  :loading="transcribeUploading || transcribing"
                  @click="transcribeFileInput?.click()"
                >
                  {{ transcribing ? 'Transcribing…' : 'Choose image' }}
                </UButton>
              </div>
              <input
                ref="transcribeFileInput"
                type="file"
                accept="image/*"
                capture="environment"
                class="hidden"
                @change="onTranscribeSelected"
              >
              <!-- Result -->
              <div
                v-if="transcribedDoc"
                class="space-y-2"
              >
                <div class="flex items-center gap-2 text-xs text-success">
                  <UIcon
                    name="i-lucide-check-circle"
                    class="size-4"
                  />
                  <NuxtLink
                    to="/documents"
                    class="hover:underline"
                  >
                    Saved to {{ transcribedDoc.path }} ↗
                  </NuxtLink>
                </div>
                <div
                  v-if="transcribedText"
                  class="p-3 rounded-md bg-muted text-xs text-default leading-relaxed max-h-40 overflow-y-auto"
                >
                  <span class="font-semibold text-muted block mb-1">Transcribed text</span>
                  {{ transcribedText }}
                </div>
                <p
                  v-else
                  class="text-xs text-dimmed"
                >
                  No text could be recognized in this image.
                </p>
              </div>
            </div>
          </template>
        </UTabs>
      </div>
    </template>
  </UDashboardPanel>
</template>
