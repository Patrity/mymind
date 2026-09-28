<script setup lang="ts">
/**
 * Source-agnostic markdown/code editor area: the header row's view-mode toggle
 * (edit / split / preview), the markdown toolbar, CodeEditor and the MdView preview.
 *
 * Extracted from documents/Editor.vue (cycle 74) so /documents, /skills and /jobs share one
 * editor. It owns presentation and editor interaction only — loading, saving, autosave and
 * status belong to the caller. Renders multiple root nodes (header row, banner slot, toolbar,
 * editor area) so it drops into the caller's own `flex flex-col` column unchanged.
 *
 * Slots: `header` (left of the header row), `actions` (right of the toggle), `banner`
 * (between the header row and the markdown toolbar).
 */
import type { CodeLanguage, EditorSelection2 } from '~/components/CodeEditor.client.vue'
import { resolveViewMode, type ViewMode } from '~/lib/documents/view-mode'

const props = withDefaults(defineProps<{
  modelValue: string
  language?: CodeLanguage
  readonly?: boolean
  /** Cookie that persists the view-mode preference. Defaults to the documents page's. */
  viewModeCookie?: string
  /** View mode used until the user picks one (i.e. while the cookie is unset). */
  defaultViewMode?: ViewMode
  /** `@paste-image` listener. Declared as a prop (Vue binds `@paste-image` to it) so that
   *  with no listener CodeEditor keeps its default paste/drop behaviour instead of swallowing
   *  the image. The caller uploads it and inserts the result via the exposed `insertText`. */
  onPasteImage?: (file: File) => void
}>(), {
  language: 'markdown',
  readonly: false,
  viewModeCookie: 'mm.documents.viewMode',
  defaultViewMode: 'edit',
  onPasteImage: undefined
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'save': []
}>()

const isMarkdown = computed(() => props.language === 'markdown')

// CodeEditor ref — used to wire toolbar transforms
const codeEditorRef = ref<{ applyTransform: (fn: (s: EditorSelection2) => EditorSelection2) => void, insertText: (s: string) => void } | null>(null)

function toolbarApplyTransform(fn: (s: EditorSelection2) => EditorSelection2) {
  codeEditorRef.value?.applyTransform(fn)
}

function toolbarInsertText(snippet: string) {
  codeEditorRef.value?.insertText(snippet)
}

// View mode preference, persisted in a cookie. This is the user's INTENT — the mode
// actually rendered is `mode` below, which can differ for one document without
// overwriting the preference.
const storedMode = useCookie<ViewMode>(props.viewModeCookie, {
  default: () => props.defaultViewMode,
  maxAge: 60 * 60 * 24 * 365
})

const mode = computed<ViewMode>(() =>
  resolveViewMode(storedMode.value, { content: props.modelValue, isMarkdown: isMarkdown.value })
)

defineExpose({ applyTransform: toolbarApplyTransform, insertText: toolbarInsertText })
</script>

<template>
  <!-- Toolbar -->
  <div class="flex items-center gap-2 px-3 py-2 border-b border-default text-sm flex-wrap shrink-0">
    <slot name="header" />

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

      <slot name="actions" />
    </div>
  </div>

  <slot name="banner" />

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
        :model-value="modelValue"
        :language="language"
        :read-only="readonly"
        :on-image="onPasteImage"
        @update:model-value="emit('update:modelValue', $event)"
        @save="emit('save')"
      />
    </div>

    <!-- Preview pane -->
    <div
      v-if="mode !== 'edit' && isMarkdown"
      class="min-h-0 overflow-auto p-4 bg-elevated/30"
      :class="mode === 'split' ? 'w-1/2' : 'w-full'"
    >
      <MdView :source="modelValue" />
    </div>
  </div>
</template>
