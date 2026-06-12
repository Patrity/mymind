<script setup lang="ts">
import type { DocumentDTO } from '~~/shared/types/documents'

type CodeLanguage = 'plaintext' | 'markdown' | 'javascript' | 'typescript' | 'json' | 'sql' | 'yaml'
type Mode = 'edit' | 'preview' | 'split'
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

import type { EditorSelection2 } from '~/components/CodeEditor.client.vue'

const props = defineProps<{
  documentId: string | null
}>()

const toast = useToast()
const { get, update, share, useDocDetail } = useDocuments()
const { upload: uploadImage } = useImages()

// Document state
const doc = ref<DocumentDTO | null>(null)
const content = ref('')
const loading = ref(false)
const saveStatus = ref<SaveStatus>('idle')
let savedContent = ''
let saveTimer: ReturnType<typeof setTimeout> | null = null

// Live detail query — keeps metadata in sync when remote changes arrive.
// We do NOT replace the content ref if the user has unsaved edits.
const { data: liveDocData } = useDocDetail(() => props.documentId)
watch(liveDocData, (fresh) => {
  if (!fresh || !doc.value || fresh.id !== doc.value.id) return
  // Sync non-content fields unconditionally (metadata saves go through here too)
  doc.value = { ...doc.value, title: fresh.title, path: fresh.path, project: fresh.project,
    domain: fresh.domain, type: fresh.type, tags: fresh.tags,
    isPublic: fresh.isPublic, publicSlug: fresh.publicSlug }
  metaPath.value = fresh.path
  metaTitle.value = fresh.title ?? ''
  metaProject.value = fresh.project ?? ''
  metaDomain.value = fresh.domain ?? ''
  metaType.value = fresh.type ?? ''
  metaTags.value = (fresh.tags ?? []).join(', ')
  // Only sync content when there are no local unsaved edits
  if (content.value === savedContent) {
    content.value = fresh.content
    savedContent = fresh.content
    doc.value = { ...doc.value, ...fresh }
  }
})

// CodeEditor ref — used to wire toolbar transforms
const codeEditorRef = ref<{ applyTransform: (fn: (s: EditorSelection2) => EditorSelection2) => void, insertText: (s: string) => void } | null>(null)

function toolbarApplyTransform(fn: (s: EditorSelection2) => EditorSelection2) {
  codeEditorRef.value?.applyTransform(fn)
}

function toolbarInsertText(snippet: string) {
  codeEditorRef.value?.insertText(snippet)
}

/** Called by CodeEditor when the user pastes or drops an image file. */
async function onEditorImage(file: File) {
  const toastId = toast.add({ color: 'neutral', title: 'Uploading image…' })
  try {
    const result = await uploadImage(file, true)
    codeEditorRef.value?.insertText(`![](${result.url})`)
    toast.remove(toastId.id)
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.remove(toastId.id)
    toast.add({ color: 'error', title: 'Upload failed', description: err.data?.statusMessage ?? err.message })
  }
}

// Metadata form fields (separate from content)
const metaPath = ref('')
const metaTitle = ref('')
const metaProject = ref('')
const metaDomain = ref('')
const metaType = ref('')
const metaTags = ref('') // comma-separated
const metaSaveTimer: Ref<ReturnType<typeof setTimeout> | null> = ref(null)

// View mode persisted in cookie
const mode = useCookie<Mode>('mm.documents.viewMode', {
  default: () => 'edit',
  maxAge: 60 * 60 * 24 * 365
})

function detectLanguage(path: string): CodeLanguage {
  const lower = path.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml'
  if (lower.endsWith('.sql')) return 'sql'
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript'
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) return 'javascript'
  return 'plaintext'
}

const language = computed<CodeLanguage>(() =>
  doc.value ? detectLanguage(doc.value.path) : 'plaintext'
)
const isMarkdown = computed(() => language.value === 'markdown')

// Fall back to edit for non-markdown files
watch(isMarkdown, (md) => {
  if (!md && mode.value !== 'edit') mode.value = 'edit'
})

const statusBadge = computed(() => {
  switch (saveStatus.value) {
    case 'saving': return { label: 'saving…', color: 'neutral' as const }
    case 'saved': return { label: 'saved', color: 'success' as const }
    case 'error': return { label: 'save failed', color: 'error' as const }
    default: return null
  }
})

async function loadDoc(id: string) {
  loading.value = true
  saveStatus.value = 'idle'
  if (saveTimer) clearTimeout(saveTimer)
  try {
    const d = await get(id)
    doc.value = d
    content.value = d.content
    savedContent = d.content
    // Populate metadata fields
    metaPath.value = d.path
    metaTitle.value = d.title ?? ''
    metaProject.value = d.project ?? ''
    metaDomain.value = d.domain ?? ''
    metaType.value = d.type ?? ''
    metaTags.value = (d.tags ?? []).join(', ')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to load document', description: err.data?.statusMessage ?? err.message })
  } finally {
    loading.value = false
  }
}

watch(() => props.documentId, (id) => {
  if (id) loadDoc(id)
  else {
    doc.value = null
    content.value = ''
    savedContent = ''
    saveStatus.value = 'idle'
  }
}, { immediate: true })

// Autosave content — debounced 1.5s
async function saveContent() {
  if (!props.documentId || !doc.value || content.value === savedContent) return
  saveStatus.value = 'saving'
  try {
    await update(props.documentId, { content: content.value })
    savedContent = content.value
    saveStatus.value = 'saved'
    setTimeout(() => {
      if (saveStatus.value === 'saved') saveStatus.value = 'idle'
    }, 2000)
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    saveStatus.value = 'error'
    toast.add({ color: 'error', title: 'Autosave failed', description: err.data?.statusMessage ?? err.message })
  }
}

function onContentUpdate(v: string) {
  content.value = v
  if (saveTimer) clearTimeout(saveTimer)
  if (v !== savedContent) {
    saveTimer = setTimeout(() => saveContent(), 1500)
  }
}

function onSaveShortcut() {
  if (saveTimer) clearTimeout(saveTimer)
  saveContent()
}

// Metadata save — debounced 800ms after any meta field change
async function saveMetadata() {
  if (!props.documentId || !doc.value) return
  const tags = metaTags.value.split(',').map(t => t.trim()).filter(Boolean)
  try {
    await update(props.documentId, {
      title: metaTitle.value || null,
      project: metaProject.value || null,
      domain: metaDomain.value || null,
      type: metaType.value || null,
      tags
    })
    // Update local doc reference
    if (doc.value) {
      doc.value = {
        ...doc.value,
        title: metaTitle.value || null,
        project: metaProject.value || null,
        domain: metaDomain.value || null,
        type: metaType.value || null,
        tags
      }
    }
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Metadata save failed', description: err.data?.statusMessage ?? err.message })
  }
}

function scheduleMetaSave() {
  if (metaSaveTimer.value) clearTimeout(metaSaveTimer.value)
  metaSaveTimer.value = setTimeout(() => saveMetadata(), 800)
}

// Share toggle
const shareLoading = ref(false)
async function toggleShare() {
  if (!props.documentId || !doc.value) return
  shareLoading.value = true
  try {
    const updated = await share(props.documentId, !doc.value.isPublic)
    doc.value = { ...doc.value, isPublic: updated.isPublic, publicSlug: updated.publicSlug }
    toast.add({
      color: 'success',
      title: updated.isPublic ? 'Document is now public' : 'Document is now private'
    })
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Share toggle failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    shareLoading.value = false
  }
}

const publicUrl = computed(() =>
  doc.value?.isPublic && doc.value?.publicSlug
    ? `/share/${doc.value.publicSlug}`
    : null
)

async function copyPublicLink() {
  if (!doc.value?.publicSlug) return
  const url = `${window.location.origin}/share/${doc.value.publicSlug}`
  let copied = false
  if (window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(url)
      copied = true
    } catch { /* fall through */ }
  }
  if (!copied) {
    const ta = document.createElement('textarea')
    ta.value = url
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, url.length)
    try { copied = document.execCommand('copy') } catch { copied = false }
    document.body.removeChild(ta)
  }
  toast.add({ color: copied ? 'success' : 'warning', title: copied ? 'Link copied' : 'Could not copy — link shown above' })
}

onUnmounted(() => {
  if (saveTimer) clearTimeout(saveTimer)
  if (metaSaveTimer.value) clearTimeout(metaSaveTimer.value)
})
</script>

<template>
  <!-- Empty state -->
  <div
    v-if="!documentId"
    class="h-full flex flex-col items-center justify-center text-dimmed"
  >
    <UIcon
      name="i-lucide-file-text"
      class="size-16 mb-4 opacity-30"
    />
    <p class="text-sm">
      Select a document to edit
    </p>
  </div>

  <!-- Loading state -->
  <div
    v-else-if="loading"
    class="h-full flex items-center justify-center"
  >
    <UIcon
      name="i-lucide-loader-2"
      class="size-6 animate-spin text-dimmed"
    />
  </div>

  <!-- Editor -->
  <div
    v-else-if="doc"
    class="h-full flex flex-col"
  >
    <!-- Toolbar -->
    <div class="flex items-center gap-2 px-3 py-2 border-b border-default text-sm flex-wrap shrink-0">
      <UIcon
        name="i-lucide-file-text"
        class="size-4 text-dimmed shrink-0"
      />
      <span
        class="font-mono text-xs text-muted truncate"
        :title="doc.path"
      >{{ doc.path }}</span>

      <!-- Save status badge -->
      <UBadge
        v-if="statusBadge"
        :color="statusBadge.color"
        variant="subtle"
        size="xs"
      >
        {{ statusBadge.label }}
      </UBadge>

      <div class="ml-auto flex items-center gap-1 shrink-0">
        <!-- View mode toggle (markdown only) -->
        <div
          v-if="isMarkdown"
          class="flex items-center rounded-md overflow-hidden border border-default"
        >
          <UButton
            icon="i-lucide-pencil"
            size="xs"
            :variant="mode === 'edit' ? 'solid' : 'ghost'"
            :color="mode === 'edit' ? 'primary' : 'neutral'"
            class="rounded-none"
            @click="mode = 'edit'"
          />
          <UButton
            icon="i-lucide-columns-2"
            size="xs"
            :variant="mode === 'split' ? 'solid' : 'ghost'"
            :color="mode === 'split' ? 'primary' : 'neutral'"
            class="rounded-none border-x border-default"
            @click="mode = 'split'"
          />
          <UButton
            icon="i-lucide-eye"
            size="xs"
            :variant="mode === 'preview' ? 'solid' : 'ghost'"
            :color="mode === 'preview' ? 'primary' : 'neutral'"
            class="rounded-none"
            @click="mode = 'preview'"
          />
        </div>

        <!-- Source image link (transcription-derived docs only) -->
        <UButton
          v-if="doc.ocrId"
          icon="i-lucide-image"
          label="View source image"
          size="xs"
          variant="link"
          color="neutral"
          :to="`/gallery?image=${doc.ocrId}`"
          title="View the source image this document was transcribed from"
        />

        <!-- Share toggle -->
        <UButton
          :icon="doc.isPublic ? 'i-lucide-globe' : 'i-lucide-lock'"
          size="xs"
          :variant="doc.isPublic ? 'soft' : 'ghost'"
          :color="doc.isPublic ? 'success' : 'neutral'"
          :loading="shareLoading"
          :title="doc.isPublic ? 'Public — click to make private' : 'Private — click to share'"
          @click="toggleShare"
        />
      </div>
    </div>

    <!-- Public URL notice — click anywhere to copy the absolute URL -->
    <div
      v-if="publicUrl"
      class="flex items-center gap-2 px-3 py-1.5 bg-success/5 border-b border-success/20 text-xs text-success shrink-0 cursor-pointer hover:bg-success/10 transition-colors select-none"
      title="Click to copy link"
      @click="copyPublicLink"
    >
      <UIcon
        name="i-lucide-copy"
        class="size-3.5 shrink-0"
      />
      <span>Public at:</span>
      <span class="underline underline-offset-2 font-mono">{{ publicUrl }}</span>
      <UIcon
        name="i-lucide-external-link"
        class="size-3 shrink-0 ml-auto opacity-60"
        @click.stop
      />
      <NuxtLink
        :to="publicUrl"
        target="_blank"
        class="opacity-60 hover:opacity-100"
        title="Open in new tab"
        @click.stop
      >
        <span class="sr-only">Open</span>
      </NuxtLink>
    </div>

    <!-- Markdown toolbar (edit/split mode only, markdown files only) -->
    <DocumentsMarkdownToolbar
      v-if="isMarkdown && mode !== 'preview'"
      :apply-transform="toolbarApplyTransform"
      :insert-text="toolbarInsertText"
    />

    <!-- Editor + Preview area -->
    <div class="flex-1 min-h-0 flex">
      <!-- Code editor pane -->
      <div
        v-if="mode !== 'preview'"
        class="min-h-0 relative"
        :class="mode === 'split' ? 'w-1/2 border-r border-default' : 'w-full'"
      >
        <!-- CodeEditor.client.vue — browser-only, no hydration concerns under SPA -->
        <CodeEditor
          ref="codeEditorRef"
          :model-value="content"
          :language="language"
          :on-image="onEditorImage"
          @update:model-value="onContentUpdate"
          @save="onSaveShortcut"
        />
      </div>

      <!-- Preview pane -->
      <div
        v-if="mode !== 'edit' && isMarkdown"
        class="min-h-0 overflow-auto p-4 bg-elevated/30"
        :class="mode === 'split' ? 'w-1/2' : 'w-full'"
      >
        <MdView :source="content" />
      </div>
    </div>

    <!-- Metadata panel -->
    <div class="shrink-0 border-t border-default bg-muted/30">
      <details class="group">
        <summary class="flex items-center gap-2 px-3 py-2 cursor-pointer select-none text-xs text-muted hover:text-default list-none">
          <UIcon
            name="i-lucide-chevron-right"
            class="size-3.5 transition-transform group-open:rotate-90"
          />
          Metadata
          <div
            v-if="doc.tags?.length || doc.project || doc.domain || doc.type"
            class="flex gap-1 ml-2"
          >
            <UBadge
              v-if="doc.project"
              color="neutral"
              variant="outline"
              size="xs"
            >
              {{ doc.project }}
            </UBadge>
            <UBadge
              v-if="doc.domain"
              color="neutral"
              variant="outline"
              size="xs"
            >
              {{ doc.domain }}
            </UBadge>
            <UBadge
              v-for="tag in doc.tags?.slice(0, 3)"
              :key="tag"
              color="primary"
              variant="outline"
              size="xs"
            >
              {{ tag }}
            </UBadge>
          </div>
        </summary>

        <div class="px-3 pb-3 grid grid-cols-2 gap-2">
          <UFormField
            label="Title"
            class="col-span-2"
          >
            <UInput
              v-model="metaTitle"
              placeholder="Document title"
              size="xs"
              class="w-full"
              @input="scheduleMetaSave"
            />
          </UFormField>

          <UFormField label="Project">
            <UInput
              v-model="metaProject"
              placeholder="project name"
              size="xs"
              class="w-full"
              @input="scheduleMetaSave"
            />
          </UFormField>

          <UFormField label="Domain">
            <UInput
              v-model="metaDomain"
              placeholder="domain"
              size="xs"
              class="w-full"
              @input="scheduleMetaSave"
            />
          </UFormField>

          <UFormField label="Type">
            <UInput
              v-model="metaType"
              placeholder="note, spec, ref…"
              size="xs"
              class="w-full"
              @input="scheduleMetaSave"
            />
          </UFormField>

          <UFormField label="Tags">
            <UInput
              v-model="metaTags"
              placeholder="tag1, tag2, tag3"
              size="xs"
              class="w-full"
              @input="scheduleMetaSave"
            />
          </UFormField>
        </div>
      </details>
    </div>
  </div>
</template>
