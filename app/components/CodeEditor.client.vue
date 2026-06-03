<script setup lang="ts">
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, EditorSelection, Compartment, type Extension } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { markdown } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'

// Supported editor languages (subset of what's installed)
type CodeLanguage = 'plaintext' | 'markdown' | 'javascript' | 'typescript' | 'json' | 'sql' | 'yaml'

const props = withDefaults(defineProps<{
  modelValue: string
  language?: CodeLanguage
  readOnly?: boolean
  autoHeight?: boolean
}>(), {
  language: 'plaintext',
  readOnly: false,
  autoHeight: false
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'save': []
}>()

const editorRef = ref<HTMLDivElement>()
let view: EditorView | null = null

const languageCompartment = new Compartment()
const readOnlyCompartment = new Compartment()
const editableCompartment = new Compartment()

function getLanguageExtension(lang: CodeLanguage): Extension {
  switch (lang) {
    case 'markdown': return markdown()
    case 'javascript': return javascript()
    case 'typescript': return javascript({ typescript: true })
    case 'json': return json()
    case 'sql': return sql()
    case 'yaml': return yaml()
    default: return []
  }
}

const baseTheme = EditorView.theme({
  '&': {
    height: props.autoHeight ? 'auto' : '100%',
    fontSize: '14px'
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'
  },
  '.cm-content': { padding: '12px 0' },
  '.cm-line': { padding: '0 16px' },
  '&.cm-focused': { outline: 'none' }
})

onMounted(() => {
  if (!editorRef.value) return

  const extensions: Extension[] = [
    basicSetup,
    languageCompartment.of(getLanguageExtension(props.language)),
    readOnlyCompartment.of(EditorState.readOnly.of(props.readOnly)),
    editableCompartment.of(EditorView.editable.of(!props.readOnly)),
    baseTheme,
    oneDark,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) emit('update:modelValue', update.state.doc.toString())
    }),
    EditorView.domEventHandlers({
      keydown(e) {
        // cmd/ctrl-S → emit save, prevent browser default
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          emit('save')
          return true
        }
        return false
      }
    })
  ]

  view = new EditorView({
    state: EditorState.create({ doc: props.modelValue, extensions }),
    parent: editorRef.value
  })
})

watch(() => props.modelValue, (next) => {
  if (view && next !== view.state.doc.toString()) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
  }
})

watch(() => props.language, (lang) => {
  if (view) view.dispatch({ effects: languageCompartment.reconfigure(getLanguageExtension(lang)) })
})

watch(() => props.readOnly, (ro) => {
  if (view) {
    view.dispatch({
      effects: [
        readOnlyCompartment.reconfigure(EditorState.readOnly.of(ro)),
        editableCompartment.reconfigure(EditorView.editable.of(!ro))
      ]
    })
  }
})

onUnmounted(() => {
  view?.destroy()
  view = null
})

// ---------------------------------------------------------------------------
// Exposed API — used by MarkdownToolbar to apply transforms
// ---------------------------------------------------------------------------
export interface EditorSelection2 {
  text: string
  from: number
  to: number
}

function getSelection(): EditorSelection2 {
  if (!view) return { text: '', from: 0, to: 0 }
  const state = view.state
  const { from, to } = state.selection.main
  return { text: state.doc.toString(), from, to }
}

function applyTransform(fn: (s: EditorSelection2) => EditorSelection2): void {
  if (!view) return
  const s = getSelection()
  const result = fn(s)
  const docLen = view.state.doc.length

  view.dispatch({
    changes: { from: 0, to: docLen, insert: result.text },
    selection: EditorSelection.range(
      Math.min(result.from, result.text.length),
      Math.min(result.to, result.text.length)
    )
  })
  view.focus()
}

function insertText(snippet: string): void {
  if (!view) return
  const { from, to } = view.state.selection.main
  view.dispatch({
    changes: { from, to, insert: snippet },
    selection: EditorSelection.cursor(from + snippet.length)
  })
  view.focus()
}

defineExpose({ getSelection, applyTransform, insertText })
</script>

<template>
  <div
    ref="editorRef"
    class="code-editor overflow-hidden"
    :class="autoHeight ? '' : 'h-full'"
  />
</template>

<style>
.code-editor.h-full .cm-editor {
  height: 100%;
}
.code-editor .cm-editor {
  background-color: var(--ui-bg);
}
.code-editor .cm-gutters {
  background-color: var(--ui-bg-muted);
  border-right: 1px solid var(--ui-border);
}
</style>
