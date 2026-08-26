<script setup lang="ts">
import type { DocumentDTO } from '~~/shared/types/documents'

type CodeLanguage = 'plaintext' | 'markdown' | 'javascript' | 'typescript' | 'json' | 'sql' | 'yaml'
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

import type { BreadcrumbItem } from '@nuxt/ui'
import type { EditorSelection2 } from '~/components/CodeEditor.client.vue'
import { createAutosave } from '~/lib/documents/autosave'
import { resolveViewMode, type ViewMode } from '~/lib/documents/view-mode'

const props = defineProps<{
  documentId: string | null
}>()

const emit = defineEmits<{
  /** A folder segment in the breadcrumb was clicked — documents.vue forwards this to
   *  Tree.vue's exposed `revealFolder()`, which expands and highlights it there. */
  selectFolder: [path: string]
}>()

const toast = useToast()
const { get, update, share, useDocDetail } = useDocuments()
const { upload: uploadImage } = useImages()

// Document state
const doc = ref<DocumentDTO | null>(null)
const content = ref('')
const loading = ref(false)
const saveStatus = ref<SaveStatus>('idle')
// Reactive so `dirty` can drive a visible unsaved indicator — text typed but not yet written
// used to be completely invisible in the UI.
const savedContent = ref('')
const dirty = computed(() => content.value !== savedContent.value)

// Live detail query — keeps content and share state in sync when remote changes arrive.
// We do NOT replace the content ref if the user has unsaved edits. Metadata (title, project,
// domain, type, tags) is synced by Inspector.vue's own copy of this watcher, guarded by its
// own metaDirty.
const { data: liveDocData } = useDocDetail(() => props.documentId)
watch(liveDocData, (fresh) => {
  if (!fresh || !doc.value || fresh.id !== doc.value.id) return
  // isPublic/publicSlug aren't part of the metadata form (they're toggled via a single button
  // click, not typed), so there's no debounce window to protect — sync unconditionally.
  doc.value = { ...doc.value, isPublic: fresh.isPublic, publicSlug: fresh.publicSlug }
  // Only sync content when there are no local unsaved edits
  if (!dirty.value) {
    content.value = fresh.content
    savedContent.value = fresh.content
    doc.value = { ...doc.value, content: fresh.content }
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

// View mode preference, persisted in a cookie. This is the user's INTENT — the mode
// actually rendered is `mode` below, which can differ for one document without
// overwriting the preference.
const storedMode = useCookie<ViewMode>('mm.documents.viewMode', {
  default: () => 'edit',
  maxAge: 60 * 60 * 24 * 365
})

const mode = computed<ViewMode>(() =>
  resolveViewMode(storedMode.value, { content: content.value, isMarkdown: isMarkdown.value })
)

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

/**
 * The toolbar's breadcrumb — replaces the old raw `font-mono` path string. Every segment except
 * the last (the document itself, rendered inactive/current) is a folder: clicking it emits
 * `selectFolder` so documents.vue can hand the path to Tree.vue's `revealFolder()`.
 *
 * `to`/`href` are deliberately never set — a real link would navigate via NuxtLink, but this
 * isn't a route change, it's "reveal this folder in the sibling tree pane". Without `to`,
 * UBreadcrumb renders a plain `<span>` (see its theme's `to: true` compound variant), so the
 * hover affordance is recreated by hand via `class` on the clickable segments only.
 */
const breadcrumbItems = computed<BreadcrumbItem[]>(() => {
  if (!doc.value) return []
  const parts = doc.value.path.split('/').filter(Boolean)
  const items: BreadcrumbItem[] = [{ icon: 'i-lucide-house' }]
  let acc = ''
  parts.forEach((part, i) => {
    acc += `/${part}`
    const folderPath = acc
    const isLast = i === parts.length - 1
    items.push({
      label: part,
      class: isLast ? undefined : 'cursor-pointer hover:text-default transition-colors',
      onClick: isLast ? undefined : () => emit('selectFolder', folderPath)
    })
  })
  return items
})

const statusBadge = computed(() => {
  switch (saveStatus.value) {
    case 'saving': return { label: 'saving…', color: 'neutral' as const }
    case 'saved': return { label: 'saved', color: 'success' as const }
    case 'error': return { label: 'save failed', color: 'error' as const }
    // Idle with unwritten text used to render nothing at all, so the one state where the
    // user could still lose work was the one state with no indicator.
    default: return dirty.value ? { label: 'unsaved', color: 'warning' as const } : null
  }
})

async function loadDoc(id: string) {
  loading.value = true
  saveStatus.value = 'idle'
  try {
    const d = await get(id)
    doc.value = d
    content.value = d.content
    savedContent.value = d.content
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to load document', description: err.data?.statusMessage ?? err.message })
  } finally {
    loading.value = false
  }
}

watch(() => props.documentId, (id, prevId) => {
  // Write the outgoing document's pending content edit before swapping. This used to
  // clearTimeout() it, so clicking another document within the debounce window discarded
  // whatever had just been typed. The save captures the OLD id/content synchronously here,
  // before loadDoc() overwrites the refs below. (Inspector.vue does the same for metadata.)
  if (prevId) {
    void autosave.flush()
  }
  if (id) loadDoc(id)
  else {
    doc.value = null
    content.value = ''
    savedContent.value = ''
    saveStatus.value = 'idle'
  }
}, { immediate: true })

// Autosave content — debounced 1.5s. The (id, content) pair travels with the pending edit
// (see ~/lib/documents/autosave) so a save that lands after a document switch still writes to
// the document the text was typed in.
const autosave = createAutosave(async (id, body) => {
  // A flush can outlive the selection that scheduled it; status is only meaningful while the
  // save's own document is still on screen.
  const isCurrent = () => props.documentId === id
  if (isCurrent()) saveStatus.value = 'saving'
  try {
    await update(id, { content: body })
    if (isCurrent()) {
      // Mark exactly what was written — not content.value, which may have moved on while the
      // request was in flight; that text is still genuinely unsaved.
      if (body === content.value) savedContent.value = body
      saveStatus.value = 'saved'
      setTimeout(() => {
        if (saveStatus.value === 'saved') saveStatus.value = 'idle'
      }, 2000)
    }
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    if (isCurrent()) saveStatus.value = 'error'
    // Toast even when the document is no longer selected — a background save that failed on
    // the way out is precisely the case the user must not miss.
    toast.add({ color: 'error', title: 'Autosave failed', description: err.data?.statusMessage ?? err.message })
  }
}, 1500)

function onContentUpdate(v: string) {
  content.value = v
  if (props.documentId && v !== savedContent.value) autosave.schedule(props.documentId, v)
}

function onSaveShortcut() {
  void autosave.flush()
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

// Tab close / reload can't be made to wait for an in-flight save, so warn instead — this is
// the one exit route a flush cannot cover.
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (dirty.value || autosave.hasPending()) e.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))

onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  // Flush, don't discard. Navigating away used to clearTimeout() the pending save outright,
  // so any edit typed in the last 1.5s was lost with no warning. Fire-and-forget is fine: the
  // request outlives the component, and the save callback guards its own status updates.
  void autosave.flush()
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

  <!-- Cold-load skeleton — only when there's no previous document to keep showing. A
       document switch (doc already set) dims the existing editor below instead. -->
  <div
    v-else-if="loading && !doc"
    class="h-full flex flex-col"
  >
    <div class="flex items-center gap-2 px-3 py-2 border-b border-default shrink-0">
      <USkeleton class="size-4 rounded" />
      <USkeleton class="h-3 w-40" />
    </div>
    <div class="flex-1 min-h-0 p-4 space-y-3">
      <USkeleton class="h-4 w-3/4" />
      <USkeleton class="h-4 w-full" />
      <USkeleton class="h-4 w-5/6" />
      <USkeleton class="h-4 w-2/3" />
      <USkeleton class="h-4 w-full" />
      <USkeleton class="h-4 w-1/2" />
    </div>
  </div>

  <!-- Editor — stays mounted and dimmed (not unmounted) while switching to another
       document, so the pane never blanks. `read-only` blocks keystrokes from landing in
       the outgoing document while it fades; `pointer-events-none` blocks clicks. -->
  <div
    v-else-if="doc"
    class="h-full flex flex-col"
    :class="{ 'opacity-60 pointer-events-none transition-opacity': loading }"
  >
    <!-- Toolbar -->
    <div class="flex items-center gap-2 px-3 py-2 border-b border-default text-sm flex-wrap shrink-0">
      <UIcon
        name="i-lucide-file-text"
        class="size-4 text-dimmed shrink-0"
      />
      <UBreadcrumb
        :items="breadcrumbItems"
        :title="doc.path"
        class="min-w-0"
        :ui="{ list: 'flex-wrap', link: 'text-xs', linkLeadingIcon: 'size-3.5', separatorIcon: 'size-3.5 shrink-0' }"
      />

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
            @click="storedMode = 'edit'"
          />
          <UButton
            icon="i-lucide-columns-2"
            size="xs"
            :variant="mode === 'split' ? 'solid' : 'ghost'"
            :color="mode === 'split' ? 'primary' : 'neutral'"
            class="rounded-none border-x border-default"
            @click="storedMode = 'split'"
          />
          <UButton
            icon="i-lucide-eye"
            size="xs"
            :variant="mode === 'preview' ? 'solid' : 'ghost'"
            :color="mode === 'preview' ? 'primary' : 'neutral'"
            class="rounded-none"
            @click="storedMode = 'preview'"
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

    <!-- Slim progress indicator while switching to another document -->
    <UProgress
      v-if="loading"
      size="xs"
      class="shrink-0"
    />

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
          :read-only="loading"
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
  </div>
</template>
