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
const imageDropZoneRef = ref<HTMLElement | null>(null)
const imagePublic = ref(false)
const imageUploading = ref(false)
const imageCreated = ref<ImageDTO | null>(null)
const imageCameraOpen = ref(false)
const imagePreviewUrl = ref<string | null>(null)
const makeDoc = ref(false)

async function uploadImage(file: File) {
  if (!file.type.startsWith('image/')) return
  imageUploading.value = true
  imageCreated.value = null
  imagePreviewUrl.value = URL.createObjectURL(file)
  try {
    const img = await images.upload(file, imagePublic.value, makeDoc.value)
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

function onImageSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) uploadImage(file)
}

function onImagePaste(e: ClipboardEvent) {
  const item = Array.from(e.clipboardData?.items ?? []).find(i => i.type.startsWith('image/'))
  const file = item?.getAsFile()
  if (file) uploadImage(file)
}

// Drag-drop for Image tab via VueUse useDropZone
const { isOverDropZone: imageIsOver } = useDropZone(imageDropZoneRef, {
  dataTypes: types => types.some(t => t.startsWith('image/')),
  onDrop: (files) => {
    const file = files?.[0]
    if (file) uploadImage(file)
  }
})

// ── Tabs ──────────────────────────────────────────────────────────────────────
const tabs = [
  { label: 'Note', slot: 'note' as const, icon: 'i-lucide-file-text' },
  { label: 'Image', slot: 'image' as const, icon: 'i-lucide-image' }
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
            <div
              class="mt-4 space-y-3"
              tabindex="0"
              @paste="onImagePaste"
            >
              <div class="flex flex-wrap items-center gap-4">
                <USwitch
                  v-model="imagePublic"
                  label="Public"
                  size="sm"
                />
                <USwitch
                  v-model="makeDoc"
                  label="Also save as document"
                  size="sm"
                />
              </div>

              <!-- Drop zone -->
              <div
                ref="imageDropZoneRef"
                class="border-2 border-dashed rounded-lg p-8 flex flex-col items-center gap-3 text-center transition-colors"
                :class="imageIsOver ? 'border-primary bg-primary/5' : 'border-default'"
              >
                <!-- Preview thumbnail -->
                <img
                  v-if="imagePreviewUrl"
                  :src="imagePreviewUrl"
                  alt="Preview"
                  class="max-h-40 rounded-md object-contain"
                >
                <template v-else>
                  <UIcon
                    name="i-lucide-image-plus"
                    class="size-10 text-muted"
                  />
                  <p class="text-sm text-muted">
                    Drop an image here, paste (Ctrl+V), or choose below
                  </p>
                </template>

                <div class="flex flex-wrap items-center justify-center gap-2">
                  <UButton
                    icon="i-lucide-upload"
                    variant="soft"
                    :loading="imageUploading"
                    @click="imageFileInput?.click()"
                  >
                    Choose file
                  </UButton>
                  <UButton
                    icon="i-lucide-camera"
                    variant="soft"
                    color="neutral"
                    :disabled="imageUploading"
                    @click="imageCameraOpen = true"
                  >
                    Use camera
                  </UButton>
                </div>
              </div>

              <!-- Hidden file input -->
              <input
                ref="imageFileInput"
                type="file"
                accept="image/*"
                class="hidden"
                @change="onImageSelected"
              >

              <!-- Success -->
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

            <!-- Camera modal for Image tab -->
            <CameraCapture
              v-model:open="imageCameraOpen"
              @capture="uploadImage"
            />
          </template>
        </UTabs>
      </div>
    </template>
  </UDashboardPanel>
</template>
