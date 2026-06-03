<script setup lang="ts">
import type { EditorSelection2 } from '~/components/CodeEditor.client.vue'
import { wrap, toggleLinePrefix, setHeading, insertAt, makeLink } from '~~/shared/utils/md-transforms'

// The editor ref comes from Editor.vue — it's the ComponentPublicInstance of CodeEditor.
// We receive a callback approach: Editor.vue passes `applyTransform` and `insertText` directly.
const props = defineProps<{
  applyTransform: (fn: (s: EditorSelection2) => EditorSelection2) => void
  insertText: (snippet: string) => void
}>()

// ---------------------------------------------------------------------------
// Toolbar action helpers
// ---------------------------------------------------------------------------
function doWrap(marker: string) {
  props.applyTransform(s => wrap(s, marker))
}

function doLinePrefix(prefix: string) {
  props.applyTransform(s => toggleLinePrefix(s, prefix))
}

function doHeading(level: number) {
  props.applyTransform(s => setHeading(s, level))
}

function doLink() {
  props.applyTransform(s => makeLink(s))
}

function doCodeBlock() {
  props.applyTransform(s => insertAt(s, '\n```\n\n```\n'))
}

// Insert MDC block snippets
function insertMDC(type: 'callout-info' | 'callout-warning' | 'callout-success' | 'callout-error' | 'note' | 'collapsible') {
  const snippets: Record<string, string> = {
    'callout-info': '\n::callout{type="info"}\nYour text here.\n::\n',
    'callout-warning': '\n::callout{type="warning"}\nYour text here.\n::\n',
    'callout-success': '\n::callout{type="success"}\nYour text here.\n::\n',
    'callout-error': '\n::callout{type="error"}\nYour text here.\n::\n',
    'note': '\n::note\nYour note here.\n::\n',
    'collapsible': '\n::collapsible{title="Details"}\nYour content here.\n::\n'
  }
  props.applyTransform(s => insertAt(s, snippets[type]!))
}

// Dropdown items for the Insert menu
const insertItems = computed(() => [
  [
    {
      label: 'Callout — Info',
      icon: 'i-lucide-info',
      onSelect: () => insertMDC('callout-info')
    },
    {
      label: 'Callout — Warning',
      icon: 'i-lucide-triangle-alert',
      onSelect: () => insertMDC('callout-warning')
    },
    {
      label: 'Callout — Success',
      icon: 'i-lucide-check-circle',
      onSelect: () => insertMDC('callout-success')
    },
    {
      label: 'Callout — Error',
      icon: 'i-lucide-x-circle',
      onSelect: () => insertMDC('callout-error')
    }
  ],
  [
    {
      label: 'Note',
      icon: 'i-lucide-sticky-note',
      onSelect: () => insertMDC('note')
    },
    {
      label: 'Collapsible',
      icon: 'i-lucide-chevrons-down-up',
      onSelect: () => insertMDC('collapsible')
    }
  ]
])
</script>

<template>
  <div class="flex items-center gap-0.5 px-2 py-1 border-b border-default bg-muted/30 flex-wrap shrink-0">
    <!-- Heading -->
    <UTooltip text="Heading 1">
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        class="font-bold font-mono"
        @click="doHeading(1)"
      >
        H1
      </UButton>
    </UTooltip>
    <UTooltip text="Heading 2">
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        class="font-bold font-mono"
        @click="doHeading(2)"
      >
        H2
      </UButton>
    </UTooltip>
    <UTooltip text="Heading 3">
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        class="font-bold font-mono"
        @click="doHeading(3)"
      >
        H3
      </UButton>
    </UTooltip>

    <div class="w-px h-4 bg-border-default mx-0.5" />

    <!-- Inline formatting -->
    <UTooltip text="Bold">
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-bold"
        @click="doWrap('**')"
      />
    </UTooltip>
    <UTooltip text="Italic">
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-italic"
        @click="doWrap('*')"
      />
    </UTooltip>
    <UTooltip text="Inline code">
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-code"
        @click="doWrap('`')"
      />
    </UTooltip>

    <div class="w-px h-4 bg-border-default mx-0.5" />

    <!-- Lists -->
    <UTooltip text="Bullet list">
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-list"
        @click="doLinePrefix('- ')"
      />
    </UTooltip>
    <UTooltip text="Numbered list">
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-list-ordered"
        @click="doLinePrefix('1. ')"
      />
    </UTooltip>
    <UTooltip text="Checkbox list">
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-list-checks"
        @click="doLinePrefix('- [ ] ')"
      />
    </UTooltip>
    <UTooltip text="Blockquote">
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-quote"
        @click="doLinePrefix('> ')"
      />
    </UTooltip>

    <div class="w-px h-4 bg-border-default mx-0.5" />

    <!-- Link + Code block -->
    <UTooltip text="Insert link">
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-link"
        @click="doLink"
      />
    </UTooltip>
    <UTooltip text="Code block">
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-square-code"
        @click="doCodeBlock"
      />
    </UTooltip>

    <div class="w-px h-4 bg-border-default mx-0.5" />

    <!-- Insert MDC block -->
    <UDropdownMenu
      :items="insertItems"
      :content="{ align: 'start', side: 'bottom', sideOffset: 4 }"
    >
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-plus-square"
        trailing-icon="i-lucide-chevron-down"
        label="Insert"
      />
    </UDropdownMenu>
  </div>
</template>
