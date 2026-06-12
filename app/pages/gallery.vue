<script setup lang="ts">
import { watchDebounced } from '@vueuse/core'
import type { ImageDTO } from '~~/shared/types/images'
import type { ListImagesParams } from '~/composables/useImages'

definePageMeta({ title: 'Gallery' })

const images = useImages()
const toast = useToast()
const route = useRoute()

// ── Search + tag filter ───────────────────────────────────────────────────────
const searchQuery = ref('')
const selectedTags = ref<string[]>([])

// Debounce ONLY the text query into the reactive query key so we don't refetch on
// every keystroke (preserves the prior 300ms search debounce). Tags apply instantly.
const debouncedQuery = ref('')
watchDebounced(searchQuery, (v) => { debouncedQuery.value = v }, { debounce: 300 })

const listParams = computed<ListImagesParams>(() => {
  const p: ListImagesParams = {}
  if (debouncedQuery.value.trim()) p.q = debouncedQuery.value.trim()
  if (selectedTags.value.length) p.tags = [...selectedTags.value]
  return p
})

// ── List state (backed by vue-query — live-updates via the global SSE invalidate) ─
const { data, error, isPending, refetch } = images.useImageList(listParams)
const items = computed<ImageDTO[]>(() => data.value ?? [])
// First-load spinner only; refetches (filters, mutations, SSE) update in place.
const loading = computed(() => isPending.value)

// Surface query/refetch errors as a toast (the imperative loader used to do this).
// Watch `error` itself, not `isFetching`: the error ref only changes identity on a
// new failure, so we toast once per distinct error instead of on every failed refetch
// (SSE-driven invalidations would otherwise produce a toast storm while the API is down).
watch(error, (err) => {
  if (!err) return
  const e = err as { data?: { statusMessage?: string }, message?: string }
  toast.add({ color: 'error', title: 'Failed to load images', description: e.data?.statusMessage ?? e.message })
})

// Derive distinct tags from loaded items (from confirmed tags only)
const allTagOptions = computed(() => {
  const set = new Set<string>()
  for (const img of items.value) {
    for (const t of img.tags) set.add(t)
  }
  return [...set].sort()
})

// ── Upload ───────────────────────────────────────────────────────────────────
const fileInput = ref<HTMLInputElement | null>(null)
const uploadPublic = ref(false)
const uploading = ref(false)

function triggerUpload() {
  fileInput.value?.click()
}

async function uploadFile(file: File) {
  uploading.value = true
  try {
    await images.upload(file, uploadPublic.value)
    toast.add({ color: 'success', title: 'Uploaded', description: file.name })
    await refetch()
  } catch (err: unknown) {
    const error = err as { data?: { statusCode?: number; statusMessage?: string }, message?: string }
    if (error.data?.statusCode === 415) {
      toast.add({ color: 'error', title: 'Unsupported file type', description: `${file.type || file.name} is not supported.` })
    } else {
      toast.add({ color: 'error', title: 'Upload failed', description: error.data?.statusMessage ?? error.message })
    }
  } finally {
    uploading.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function onFileSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  await uploadFile(file)
}

// ── Drag-drop upload (page-level) ─────────────────────────────────────────────
const galleryRoot = ref<HTMLElement | null>(null)

const { isOverDropZone } = useDropZone(galleryRoot, {
  dataTypes: types => types.some(t => t.startsWith('image/') || t.startsWith('video/')),
  onDrop: async (files) => {
    if (!files) return
    for (const file of files) {
      await uploadFile(file)
    }
  }
})

// ── Paste upload (page-level) ─────────────────────────────────────────────────
function onPagePaste(e: ClipboardEvent) {
  const pasteItems = Array.from(e.clipboardData?.items ?? [])
  const imageItem = pasteItems.find(i => i.type.startsWith('image/'))
  const file = imageItem?.getAsFile()
  if (file) uploadFile(file)
}

// ── Detail modal ─────────────────────────────────────────────────────────────
const selected = ref<ImageDTO | null>(null)
const detailOpen = ref(false)
const mutating = ref(false)

// Snapshot of last server-synced editable fields, so blur only PATCHes real edits.
// Normalized null→'' so an untouched null field doesn't read as a change.
const syncedSummary = ref('')
const syncedOcr = ref('')

function syncEditSnapshot(img: ImageDTO) {
  syncedSummary.value = img.summary ?? ''
  syncedOcr.value = img.ocrText ?? ''
}

function openDetail(img: ImageDTO) {
  selected.value = { ...img }
  syncEditSnapshot(img)
  detailOpen.value = true
}

function closeDetail() {
  detailOpen.value = false
  selected.value = null
}

// ── Deep-link: ?image=<id> opens that image's detail modal ────────────────────
// The list loads async; this matches reactively once items are available. If the
// id isn't in the (possibly filtered) list, it fails gracefully — no modal.
// `handledImageQuery` ensures we only auto-open once per distinct ?image= value,
// so unrelated list updates (filters, mutations) don't re-trigger the modal.
const handledImageQuery = ref<string | null>(null)

function openImageFromQuery() {
  const id = route.query.image
  if (typeof id !== 'string' || !id) {
    handledImageQuery.value = null
    return
  }
  if (id === handledImageQuery.value) return
  const match = items.value.find(i => i.id === id)
  if (match) {
    handledImageQuery.value = id
    openDetail(match)
  }
}

// Re-run when the list finishes loading or the query changes.
watch([items, () => route.query.image], () => openImageFromQuery())

async function withMutate(fn: () => Promise<ImageDTO>) {
  mutating.value = true
  try {
    const updated = await fn()
    // Keep modal in sync; the list is a read-only computed backed by vue-query.
    selected.value = { ...updated }
    syncEditSnapshot(updated)
    // Refetch for immediate local refresh (cross-tab is handled by the SSE event).
    await refetch()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Action failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    mutating.value = false
  }
}

async function onTogglePublic(val: boolean) {
  if (!selected.value) return
  await withMutate(() => images.setPublic(selected.value!.id, val))
}

async function onApproveTag(tag: string) {
  if (!selected.value) return
  await withMutate(() => images.approveTag(selected.value!, tag))
}

async function onDismissTag(tag: string) {
  if (!selected.value) return
  await withMutate(() => images.dismissTag(selected.value!, tag))
}

async function onRemoveTag(tag: string) {
  if (!selected.value) return
  await withMutate(() => images.removeTag(selected.value!, tag))
}

async function onReprocess() {
  if (!selected.value) return
  await withMutate(() => images.reprocess(selected.value!.id))
}

async function onRevectorize() {
  if (!selected.value) return
  await withMutate(() => images.revectorize(selected.value!.id))
}

async function onSaveSummary() {
  if (!selected.value) return
  // Dirty-check: skip PATCH if unchanged from last synced value (null/'' normalized)
  if ((selected.value.summary ?? '') === syncedSummary.value) return
  await withMutate(() => images.updateMeta(selected.value!.id, { summary: selected.value!.summary }))
}

async function onSaveOcr() {
  if (!selected.value) return
  if ((selected.value.ocrText ?? '') === syncedOcr.value) return
  await withMutate(() => images.updateMeta(selected.value!.id, { ocrText: selected.value!.ocrText }))
}

// ── Custom tag input ──────────────────────────────────────────────────────────
const newTag = ref('')

async function onAddTag() {
  if (!selected.value) return
  const tag = newTag.value.trim()
  newTag.value = ''
  // Dedup guard: no-op (but still clear input) if empty or already present
  if (!tag || selected.value.tags.includes(tag)) return
  await withMutate(() => images.addTag(selected.value!, tag))
}

const statusColor = (status: string): 'info' | 'error' | 'success' | 'neutral' => {
  if (status === 'processing') return 'info'
  if (status === 'failed') return 'error'
  if (status === 'done') return 'success'
  return 'neutral'
}

// ── Delete ───────────────────────────────────────────────────────────────────
const confirmDelete = ref(false)
const deleting = ref(false)

async function onDelete() {
  if (!selected.value) return
  deleting.value = true
  try {
    await images.remove(selected.value.id)
    toast.add({ color: 'success', title: 'Image deleted' })
    closeDetail()
    confirmDelete.value = false
    // List is a read-only computed; refetch to drop the deleted item locally
    // (cross-tab is handled by the SSE event the delete emits).
    await refetch()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Delete failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    deleting.value = false
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function isVideo(img: ImageDTO): boolean {
  return img.kind === 'video' || (img.mime?.startsWith('video/') ?? false)
}

function publicUrl(img: ImageDTO): string {
  if (!img.publicSlug) return ''
  return `${window.location.origin}/api/i/${img.publicSlug}`
}

async function copyUrl(img: ImageDTO) {
  const url = publicUrl(img)
  if (!url) return
  await navigator.clipboard.writeText(url)
  toast.add({ color: 'success', title: 'URL copied' })
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
</script>

<template>
  <div
    ref="galleryRoot"
    class="contents"
    tabindex="-1"
    @paste="onPagePaste"
  >
    <!-- Drag overlay -->
    <Transition name="fade">
      <div
        v-if="isOverDropZone"
        class="fixed inset-0 z-50 flex items-center justify-center bg-primary/20 border-4 border-dashed border-primary pointer-events-none"
      >
        <div class="bg-default rounded-xl px-8 py-6 flex flex-col items-center gap-3 shadow-xl">
          <UIcon
            name="i-lucide-upload-cloud"
            class="size-12 text-primary"
          />
          <p class="text-lg font-semibold text-default">
            Drop to upload
          </p>
        </div>
      </div>
    </Transition>

    <UDashboardPanel
      id="gallery"
      grow
      :ui="{ body: '!p-0' }"
    >
      <template #header>
        <UDashboardNavbar title="Gallery">
          <template #leading>
            <UDashboardSidebarCollapse />
          </template>
          <template #right>
            <div class="flex items-center gap-2 flex-wrap">
              <!-- Search -->
              <UInput
                v-model="searchQuery"
                icon="i-lucide-search"
                placeholder="Search OCR & tags…"
                size="sm"
                class="w-44"
                :ui="{ trailing: 'pr-1' }"
              />
              <!-- Tag multiselect -->
              <USelectMenu
                v-model="selectedTags"
                :items="allTagOptions"
                multiple
                placeholder="Filter tags…"
                size="sm"
                class="w-40"
              />
              <USwitch
                v-model="uploadPublic"
                label="Public"
                size="xs"
              />
              <UButton
                icon="i-lucide-upload"
                size="sm"
                :loading="uploading"
                @click="triggerUpload"
              >
                Upload
              </UButton>
            </div>
            <!-- Hidden file input -->
            <input
              ref="fileInput"
              type="file"
              accept="image/*,video/mp4,video/webm,video/quicktime"
              class="hidden"
              @change="onFileSelected"
            >
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <!-- Loading skeletons -->
        <div
          v-if="loading"
          class="p-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3"
        >
          <USkeleton
            v-for="i in 12"
            :key="i"
            class="aspect-square rounded-lg"
          />
        </div>

        <!-- Empty state -->
        <div
          v-else-if="items.length === 0"
          class="flex flex-col items-center justify-center h-full py-32 gap-4 text-center"
        >
          <UIcon
            name="i-lucide-image"
            class="size-14 text-muted"
          />
          <div>
            <p class="text-sm font-medium text-default">
              {{ searchQuery || selectedTags.length ? 'No results match your filters' : 'No images yet — upload, drag & drop, or paste' }}
            </p>
            <p class="text-xs text-muted mt-1">
              {{ searchQuery || selectedTags.length ? 'Try adjusting your search or tag filter.' : 'Images will appear here once added.' }}
            </p>
          </div>
          <UButton
            v-if="!searchQuery && !selectedTags.length"
            icon="i-lucide-upload"
            size="sm"
            variant="soft"
            :loading="uploading"
            @click="triggerUpload"
          >
            Upload an image
          </UButton>
        </div>

        <!-- Grid -->
        <div
          v-else
          class="p-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3"
        >
          <button
            v-for="img in items"
            :key="img.id"
            class="group relative aspect-square rounded-lg overflow-hidden bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            @click="openDetail(img)"
          >
            <!-- Video thumbnail -->
            <video
              v-if="isVideo(img)"
              :src="img.url"
              class="w-full h-full object-cover transition-opacity group-hover:opacity-80"
              preload="metadata"
              muted
            />
            <!-- Image thumbnail -->
            <img
              v-else
              :src="img.url"
              :alt="img.originalName ?? img.id"
              loading="lazy"
              class="w-full h-full object-cover transition-opacity group-hover:opacity-80"
            >
            <!-- Video indicator -->
            <div
              v-if="isVideo(img)"
              class="absolute inset-0 flex items-center justify-center pointer-events-none"
            >
                <UIcon
                  name="i-lucide-play"
                  class="size-5 text-white"
                />
            </div>
            <!-- Public/private badge -->
            <div class="absolute top-1.5 right-1.5">
              <UBadge
                v-if="img.isPublic"
                icon="i-lucide-globe"
                color="success"
                variant="solid"
                size="xs"
              />
              <UBadge
                v-else
                icon="i-lucide-lock"
                color="neutral"
                variant="solid"
                size="xs"
              />
            </div>
            <!-- Recommended tags indicator -->
            <div
              v-if="img.recommendedTags.length > 0"
              class="absolute bottom-1.5 left-1.5"
            >
              <UBadge
                :label="`${img.recommendedTags.length} suggested`"
                color="warning"
                variant="solid"
                size="xs"
              />
            </div>
          </button>
        </div>
      </template>
    </UDashboardPanel>

    <!-- Detail modal -->
    <UModal
      v-model:open="detailOpen"
      :ui="{ content: 'max-w-2xl' }"
      @update:open="(v) => { if (!v) closeDetail() }"
    >
      <template #content>
        <div
          v-if="selected"
          class="flex flex-col gap-0 overflow-auto"
        >
          <!-- Video preview -->
          <div
            v-if="isVideo(selected)"
            class="bg-muted rounded-t-lg overflow-hidden max-h-80 flex items-center justify-center"
          >
            <video
              controls
              :src="selected.url"
              class="max-h-80 max-w-full"
              autoplay
              loop
            />
          </div>
          <!-- Image preview -->
          <div
            v-else
            class="bg-muted rounded-t-lg overflow-hidden max-h-80 flex items-center justify-center"
          >
            <img
              :src="selected.url"
              :alt="selected.originalName ?? selected.id"
              class="max-h-80 max-w-full object-contain"
            >
          </div>

          <div class="p-4 space-y-4">
            <!-- Meta row -->
            <div class="flex items-center gap-2 flex-wrap text-xs text-muted">
              <span>{{ selected.mime }}</span>
              <span>·</span>
              <span>{{ formatBytes(selected.size) }}</span>
              <template v-if="selected.width && selected.height">
                <span>·</span>
                <span>{{ selected.width }}×{{ selected.height }}</span>
              </template>
              <span>·</span>
              <span>{{ new Date(selected.createdAt).toLocaleString() }}</span>
            </div>

            <!-- Enrichment status -->
            <div class="flex items-center gap-2 flex-wrap">
              <UBadge
                :label="selected.enrichStatus"
                :color="statusColor(selected.enrichStatus)"
                variant="subtle"
                size="sm"
              />
              <p
                v-if="selected.enrichStatus === 'failed' && selected.enrichError"
                class="text-xs text-error"
              >
                {{ selected.enrichError }}
              </p>
            </div>

            <!-- Summary -->
            <div class="space-y-1.5">
              <p class="text-xs font-medium text-muted">
                Summary
              </p>
              <UTextarea
                :model-value="selected.summary ?? ''"
                :rows="3"
                autoresize
                placeholder="No summary yet…"
                class="w-full"
                :disabled="mutating"
                @update:model-value="selected.summary = $event"
                @blur="onSaveSummary"
              />
            </div>

            <!-- OCR text -->
            <div class="space-y-1.5">
              <p class="text-xs font-medium text-muted">
                OCR text
              </p>
              <UTextarea
                :model-value="selected.ocrText ?? ''"
                :rows="3"
                autoresize
                placeholder="No OCR text yet…"
                class="w-full"
                :disabled="mutating"
                @update:model-value="selected.ocrText = $event"
                @blur="onSaveOcr"
              />
            </div>

            <!-- Confirmed tags -->
            <div class="space-y-1.5">
              <p class="text-xs font-medium text-muted">
                Tags
              </p>
              <div
                v-if="selected.tags.length > 0"
                class="flex flex-wrap gap-1.5"
              >
                <span
                  v-for="tag in selected.tags"
                  :key="tag"
                  class="inline-flex items-center gap-1"
                >
                  <UBadge
                    :label="tag"
                    color="primary"
                    variant="subtle"
                    size="sm"
                  />
                  <button
                    class="text-muted hover:text-error transition-colors"
                    :disabled="mutating"
                    aria-label="Remove tag"
                    @click="onRemoveTag(tag)"
                  >
                    <UIcon
                      name="i-lucide-x"
                      class="size-3"
                    />
                  </button>
                </span>
              </div>
              <p
                v-else
                class="text-xs text-dimmed"
              >
                No tags yet.
              </p>
              <div class="flex items-center gap-2 pt-1">
                <UInput
                  v-model="newTag"
                  placeholder="Add a tag…"
                  size="sm"
                  class="flex-1"
                  :disabled="mutating"
                  @keydown.enter.prevent="onAddTag"
                />
                <UButton
                  icon="i-lucide-plus"
                  size="sm"
                  color="primary"
                  variant="subtle"
                  :loading="mutating"
                  :disabled="!newTag.trim()"
                  @click="onAddTag"
                >
                  Add
                </UButton>
              </div>
            </div>

            <!-- Recommended tags -->
            <div
              v-if="selected.recommendedTags.length > 0"
              class="space-y-1.5"
            >
              <p class="text-xs font-medium text-muted">
                Suggested tags
              </p>
              <div class="flex flex-wrap gap-1.5">
                <span
                  v-for="tag in selected.recommendedTags"
                  :key="tag"
                  class="inline-flex items-center"
                >
                  <UBadge
                    color="warning"
                    variant="subtle"
                    size="sm"
                  >
                  <template #default>
                  <span class="text-xs mx-2 py-1">
                    {{ tag }}
                  </span>
                  </template>
                  <template #trailing>
                    <UFieldGroup>
                    <UButton
                      icon="i-lucide-check"
                      size="xs"
                      color="success"
                      variant="subtle"
                      :loading="mutating"
                      aria-label="Approve tag"
                      @click="onApproveTag(tag)"
                    />
                    <UButton
                      icon="i-lucide-x"
                      size="xs"
                      color="error"
                      variant="subtle"
                      :loading="mutating"
                      aria-label="Dismiss tag"
                      @click="onDismissTag(tag)"
                    />
                    </UFieldGroup>
                  </template>
                  </UBadge>
                </span>
              </div>
            </div>

            <!-- Public toggle -->
            <div class="space-y-2">
              <USwitch
                :model-value="selected.isPublic"
                label="Public"
                :loading="mutating"
                @update:model-value="onTogglePublic"
              />
              <div
                v-if="selected.isPublic && selected.publicSlug"
                class="flex items-center gap-2"
              >
                <code class="text-xs bg-muted px-2 py-1 rounded flex-1 truncate text-muted font-mono">
                  {{ publicUrl(selected) }}
                </code>
                <UButton
                  icon="i-lucide-copy"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  aria-label="Copy URL"
                  @click="copyUrl(selected!)"
                />
              </div>
            </div>

            <!-- Actions -->
            <div class="flex justify-between items-center pt-1 border-t border-default">
              <UButton
                icon="i-lucide-trash-2"
                color="error"
                variant="ghost"
                size="sm"
                :loading="deleting"
                @click="confirmDelete = true"
              >
                Delete
              </UButton>
              <div class="flex items-center gap-2">
                <UButton
                  icon="i-lucide-refresh-cw"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :loading="mutating"
                  @click="onReprocess"
                >
                  Reprocess
                </UButton>
                <UButton
                  icon="i-lucide-sparkles"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :loading="mutating"
                  @click="onRevectorize"
                >
                  Revectorize
                </UButton>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  @click="closeDetail"
                >
                  Close
                </UButton>
              </div>
            </div>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Delete confirmation modal -->
    <UModal v-model:open="confirmDelete">
      <template #content>
        <UCard>
          <template #header>
            <div class="flex items-center gap-2">
              <UIcon
                name="i-lucide-trash-2"
                class="size-5 text-error"
              />
              <span class="font-semibold">Delete image?</span>
            </div>
          </template>

          <p class="text-sm text-muted">
            This action cannot be undone. The image will be permanently removed.
          </p>

          <template #footer>
            <div class="flex justify-end gap-2">
              <UButton
                color="neutral"
                variant="ghost"
                :disabled="deleting"
                @click="confirmDelete = false"
              >
                Cancel
              </UButton>
              <UButton
                color="error"
                :loading="deleting"
                @click="onDelete"
              >
                Delete
              </UButton>
            </div>
          </template>
        </UCard>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
