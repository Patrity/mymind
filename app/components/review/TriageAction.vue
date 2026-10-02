<script setup lang="ts">
// One triage action, said plainly: what gets created or changed, where, and with what text.
// Mirrors the actuators in server/services/triage.ts — applyNote retitles + moves the capture
// (a new document), applyAppend adds a delimited block to the END of an existing document and
// never edits its content, applyTask/applyMemory turn the capture into a task/memory. Every
// kind except `note` removes the /input capture once it has been used.

interface TriageActionView {
  kind: 'task' | 'note' | 'memory' | 'append'
  confidence: number
  title?: string | null
  project?: string | null
  priority?: 'low' | 'medium' | 'high'
  dueDate?: string | null
  scope?: 'user' | 'agent' | 'world'
  content?: string | null
  path?: string | null
  target?: { id: string, path: string, title: string | null } | null
}

const props = defineProps<{
  action: TriageActionView
  /** The capture's text (footer stripped) — the default content of every action. */
  sourceText: string
  /** Already applied automatically: read-only, muted. */
  applied?: boolean
}>()

const ICON: Record<TriageActionView['kind'], string> = {
  note: 'i-lucide-file-plus',
  append: 'i-lucide-file-pen-line',
  task: 'i-lucide-list-todo',
  memory: 'i-lucide-brain'
}

const body = computed(() => props.action.content?.trim() || props.sourceText)
const showsOwnText = computed(() => !!props.action.content?.trim() && props.action.content.trim() !== props.sourceText.trim())

const headline = computed(() => {
  const a = props.action
  switch (a.kind) {
    case 'note': return { verb: 'Create document', object: a.title ?? 'Untitled note' }
    case 'append': return a.target
      ? { verb: 'Append to', object: a.target.title ?? a.target.path }
      : { verb: 'Create document', object: a.title ?? 'Untitled note' }
    case 'task': return { verb: 'Create task', object: a.title ?? 'Untitled task' }
    case 'memory': return { verb: `Save ${a.scope ?? 'user'} memory`, object: null }
    default: return { verb: a.kind, object: null }
  }
})
</script>

<template>
  <div
    class="p-3 rounded-md space-y-2"
    :class="applied ? 'bg-muted/50' : 'bg-muted'"
  >
    <div class="flex items-start gap-2">
      <UIcon
        :name="ICON[action.kind]"
        class="size-4 mt-0.5 shrink-0"
        :class="applied ? 'text-dimmed' : 'text-primary'"
      />
      <div class="min-w-0 flex-1 space-y-1">
        <p
          class="text-sm"
          :class="applied ? 'text-muted' : 'text-default'"
        >
          {{ headline.verb }}
          <span
            v-if="headline.object"
            class="font-semibold text-highlighted ml-1"
          >{{ headline.object }}</span>
        </p>

        <!-- Where it lands -->
        <p
          v-if="action.kind === 'note' && action.path"
          class="text-xs font-mono text-muted break-all"
        >
          → {{ action.path }}
        </p>
        <p
          v-else-if="action.kind === 'append' && action.target"
          class="text-xs font-mono text-muted break-all"
        >
          {{ action.target.path }}
        </p>
        <div
          v-else-if="action.kind === 'task'"
          class="flex items-center gap-1.5 flex-wrap"
        >
          <UBadge
            :label="action.project ?? 'no project'"
            color="neutral"
            variant="soft"
            size="xs"
            icon="i-lucide-folder"
          />
          <UBadge
            :label="`${action.priority ?? 'low'} priority`"
            color="neutral"
            variant="soft"
            size="xs"
          />
          <UBadge
            v-if="action.dueDate"
            :label="`due ${action.dueDate.slice(0, 10)}`"
            color="neutral"
            variant="soft"
            size="xs"
          />
        </div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <UBadge
          v-if="applied"
          label="auto-applied"
          color="success"
          variant="subtle"
          size="xs"
        />
        <span class="text-xs text-dimmed">{{ Math.round(action.confidence * 100) }}%</span>
      </div>
    </div>

    <!-- What changes, in one line -->
    <p class="text-xs text-muted pl-6">
      <template v-if="action.kind === 'note'">
        The capture above becomes this document. Nothing else is changed.
      </template>
      <template v-else-if="action.kind === 'append' && action.target">
        Adds the block below to the end of this document. Its existing content is not changed; the capture is then removed from /input.
      </template>
      <template v-else-if="action.kind === 'append'">
        No existing document is close enough to append to, so the capture will be filed as a new note instead.
      </template>
      <template v-else-if="action.kind === 'task'">
        The captured text becomes the task description; the capture is then removed from /input.
      </template>
      <template v-else>
        The capture is then removed from /input.
      </template>
    </p>

    <!-- The exact text an append adds, or a memory/task's own wording when it differs from the capture -->
    <div
      v-if="(action.kind === 'append' && action.target) || action.kind === 'memory' || showsOwnText"
      class="ml-6 pl-3 py-2 pr-2 border-l-2 rounded-r max-h-64 overflow-auto"
      :class="action.kind === 'append' ? 'border-success bg-success/10' : 'border-default bg-elevated'"
    >
      <MdView :source="body" />
    </div>
  </div>
</template>
