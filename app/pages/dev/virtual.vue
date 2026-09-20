<script setup lang="ts">
// Task 0 spike (cycle 66): does @tanstack/vue-virtual measure variable-height rows and hold
// scroll position when older rows are prepended? Gate for the /sessions/[id] rebuild — Task 8
// copies this useVirtualizer usage pattern (measured rows via measureElement, data-vrow on
// each row wrapper) if the answer is yes.
//
// Not in production builds at all (nuxt.config `$production.ignore: ['app/pages/dev/**']`);
// the guard below is belt and braces, matching dev/elements.vue.
import type { ComponentPublicInstance } from 'vue'
import { computed, nextTick, ref } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { SessionMessageDTO, SessionToolEventDTO } from '~~/shared/types/session'

if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: 'Not found', fatal: true })
definePageMeta({ title: 'Virtual list spike' })

interface Row {
  id: string
  text: string
}

// Deliberately varying height: cycle the text length so rows wrap to different numbers of
// lines (per the brief: `'x '.repeat((i % 40) + 1)`).
function makeText(i: number): string {
  return 'x '.repeat((i % 40) + 1)
}

const rows = ref<Row[]>(
  Array.from({ length: 2000 }, (_, i) => ({ id: `init-${i}`, text: makeText(i) }))
)

const scrollParent = ref<HTMLElement | null>(null)

// options must be a computed/ref for useVirtualizer to react to `rows` changing (it watches
// unref(options) internally) — a plain object here would never re-run on prepend.
const virtualizerOptions = computed(() => ({
  count: rows.value.length,
  getScrollElement: () => scrollParent.value,
  estimateSize: () => 140,
  overscan: 8,
  // Stable, id-based keys (not index) so the measurement cache for existing rows survives a
  // prepend — the row that WAS at index 0 keeps its own cached size even though its index
  // shifts by 100.
  getItemKey: (index: number) => rows.value[index]?.id ?? index
}))

const virtualizer = useVirtualizer(virtualizerOptions)
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

function measureRow(el: Element | ComponentPublicInstance | null) {
  if (!el || !(el instanceof HTMLElement)) return
  virtualizer.value.measureElement(el)
}

function scrollToMiddle() {
  virtualizer.value.scrollToIndex(1000, { align: 'start' })
}

function scrollToEnd() {
  virtualizer.value.scrollToIndex(rows.value.length - 1, { align: 'end' })
}

const mountedRowCount = ref(0)
function recountMountedRows() {
  mountedRowCount.value = scrollParent.value?.querySelectorAll('[data-vrow]').length ?? 0
}

// --- Scroll-anchoring proof --------------------------------------------------------------
// "Row at the viewport top" = the last rendered row whose absolute `start` offset (the same
// pixel value used for its `translateY`) is <= the container's current scrollTop. That is a
// direct read of virtualizer-computed layout, not a heuristic.
interface TopRowSnapshot {
  scrollTop: number
  /** Stable row id (the virtualizer key) — identity check, unaffected by index renumbering. */
  topRowId: string
  /** Full rendered text (includes the index, which legitimately changes on prepend). */
  topRowText: string
}

function readTopRow(): TopRowSnapshot {
  const el = scrollParent.value
  if (!el) return { scrollTop: 0, topRowId: '', topRowText: '' }
  const scrollTop = el.scrollTop
  const rowEls = Array.from(el.querySelectorAll<HTMLElement>('[data-vrow]'))
  let top: HTMLElement | undefined
  for (const r of rowEls) {
    const start = Number(r.dataset.start ?? '0')
    if (start <= scrollTop) top = r
    else break
  }
  return {
    scrollTop,
    topRowId: top?.dataset.vrow ?? '',
    topRowText: top?.textContent?.trim() ?? ''
  }
}

// Wait for the native `scroll` event (fired asynchronously relative to a programmatic
// `el.scrollTop = x` assignment — NOT synchronously, and NOT just a Vue microtask away) to
// reach the virtualizer's scroll listener, trigger its onChange, and for the resulting
// `virtualRows` re-render to land. A single `nextTick()` right after setting scrollTop is not
// enough — reading the DOM at that point still reflects the PRE-correction render pass.
function waitForScrollSettle(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

interface AnchorProof {
  before: TopRowSnapshot
  after: TopRowSnapshot
  same: boolean
  scrollTopDelta: number
  heightDelta: number
}

const lastProof = ref<AnchorProof | null>(null)
let prependBatch = 0

async function prependOneHundred() {
  const el = scrollParent.value
  if (!el) return

  const before = readTopRow()
  const beforeHeight = el.scrollHeight

  const batch = prependBatch++
  const newRows: Row[] = Array.from({ length: 100 }, (_, i) => ({
    id: `prepend-${batch}-${i}`,
    text: makeText(i)
  }))
  rows.value = [...newRows, ...rows.value]

  // One tick for the options watcher (virtualizer.setOptions + _willUpdate) to run, a second
  // for the resulting re-render (new/shifted rows, ref-callback measurement) to land.
  await nextTick()
  await nextTick()

  const afterHeight = el.scrollHeight
  const heightDelta = afterHeight - beforeHeight
  el.scrollTop = before.scrollTop + heightDelta

  await waitForScrollSettle()
  await nextTick()
  const after = readTopRow()

  lastProof.value = {
    before,
    after,
    same: before.topRowId === after.topRowId,
    scrollTopDelta: after.scrollTop - before.scrollTop,
    heightDelta
  }
}

// ── Task 7 fixture: every SessionsTranscriptRow shape ────────────────────────────────────
// One of each shape called out in the brief: short user message, long (clampable) assistant
// message, a message with `thinking`, a successful tool event, a failed one (exitStatus:
// 'error'), one whose result is an object, an isSidechain message, and a 300,000-char body
// (prod's largest message is 279,751 chars) to prove the expand-cap doesn't blow out the page.
const LONG_ASSISTANT_BODY = [
  'Checked your notes and the web for Orpheus. It looks like the project is a self-hosted,',
  'permissively-licensed TTS engine with multilingual support and a small footprint compared to',
  'other open models. A few things worth flagging before you commit to it: first, the inference',
  'server expects a GPU with at least 6GB of VRAM for the larger checkpoints, though the small',
  'checkpoint runs acceptably on CPU for short utterances. Second, voice cloning support is',
  'still marked experimental upstream, so expect rough edges if that is the primary use case.',
  'Third, the packaged Docker image pulls in a fairly large CUDA base image, so budget disk',
  'space accordingly on the homelab box. I can draft a task to track a trial install if you want.'
].join(' ')

const rowMessages: SessionMessageDTO[] = [
  {
    id: 'row-user-short',
    role: 'user',
    content: 'Where did I leave the Orpheus notes?',
    thinking: null,
    model: null,
    isSidechain: false,
    metadata: {},
    createdAt: '2026-09-19T10:00:00.000Z'
  },
  {
    id: 'row-assistant-long',
    role: 'assistant',
    content: LONG_ASSISTANT_BODY,
    thinking: null,
    model: 'claude-sonnet-5',
    isSidechain: false,
    metadata: {},
    createdAt: '2026-09-19T10:00:05.000Z'
  },
  {
    id: 'row-thinking',
    role: 'assistant',
    content: 'Checked the docs first, then confirmed with a search — the notes are under the TTS project.',
    thinking: 'The user wants to know where the Orpheus notes live. I should search documents before answering rather than guessing from memory.',
    model: 'claude-sonnet-5',
    isSidechain: false,
    metadata: {},
    createdAt: '2026-09-19T10:00:10.000Z'
  },
  {
    id: 'row-tool-ok',
    role: 'assistant',
    content: 'Found it — the Orpheus notes are filed under the TTS project.',
    thinking: null,
    model: 'claude-sonnet-5',
    isSidechain: false,
    metadata: {},
    createdAt: '2026-09-19T10:00:15.000Z'
  },
  {
    id: 'row-tool-error',
    role: 'assistant',
    content: 'That fetch failed — let me try a different source.',
    thinking: null,
    model: 'claude-sonnet-5',
    isSidechain: false,
    metadata: {},
    createdAt: '2026-09-19T10:00:20.000Z'
  },
  {
    id: 'row-tool-object-result',
    role: 'assistant',
    content: 'Filed a task so you don’t lose track of this.',
    thinking: null,
    model: 'claude-sonnet-5',
    isSidechain: false,
    metadata: {},
    createdAt: '2026-09-19T10:00:25.000Z'
  },
  {
    id: 'row-sidechain',
    role: 'assistant',
    content: 'Sidechain: cross-checked the research subagent’s summary before folding it back in.',
    thinking: null,
    model: 'claude-sonnet-5',
    isSidechain: true,
    metadata: {},
    createdAt: '2026-09-19T10:00:30.000Z'
  },
  {
    id: 'row-huge',
    role: 'assistant',
    // 300,000 chars, deliberately past prod's largest recorded message (279,751).
    content: 'orpheus tts notes. '.repeat(15_790),
    thinking: null,
    model: 'claude-sonnet-5',
    isSidechain: false,
    metadata: {},
    createdAt: '2026-09-19T10:00:35.000Z'
  }
]

const rowToolEvents: SessionToolEventDTO[] = [
  {
    id: 'te-ok',
    messageId: 'row-tool-ok',
    toolName: 'search_docs',
    args: { query: 'orpheus', limit: 5 },
    result: 'Found 3 matches under project "tts".',
    exitStatus: 'ok',
    phase: 'result',
    toolUseId: 'tu-ok',
    isSidechain: false,
    createdAt: '2026-09-19T10:00:16.000Z'
  },
  {
    id: 'te-error',
    messageId: 'row-tool-error',
    toolName: 'web_fetch',
    args: { url: 'https://example.com/notes' },
    result: '403 Forbidden',
    exitStatus: 'error',
    phase: 'result',
    toolUseId: 'tu-error',
    isSidechain: false,
    createdAt: '2026-09-19T10:00:21.000Z'
  },
  {
    id: 'te-object-result',
    messageId: 'row-tool-object-result',
    toolName: 'create_task',
    args: { title: 'Try Orpheus TTS' },
    result: { id: 'task-1', title: 'Try Orpheus TTS', status: 'open' },
    exitStatus: 'ok',
    phase: 'result',
    toolUseId: 'tu-object',
    isSidechain: false,
    createdAt: '2026-09-19T10:00:26.000Z'
  }
]

const rowToolEventsByMessage = computed(() => {
  const m = new Map<string, SessionToolEventDTO[]>()
  for (const te of rowToolEvents) {
    if (!te.messageId) continue
    const arr = m.get(te.messageId) ?? []
    arr.push(te)
    m.set(te.messageId, arr)
  }
  return m
})

function toolEventsFor(id: string): SessionToolEventDTO[] {
  return rowToolEventsByMessage.value.get(id) ?? []
}
</script>

<template>
  <div class="h-full overflow-y-auto p-4 space-y-4">
    <div class="space-y-2">
      <h1 class="text-lg font-semibold text-highlighted">
        Virtual list spike (@tanstack/vue-virtual)
      </h1>
      <p class="text-sm text-muted" data-row-count>
        {{ rows.length }} rows &middot; mounted: <span data-mounted-count>{{ mountedRowCount }}</span>
        &middot; total size: {{ totalSize }}px
      </p>
      <div class="flex flex-wrap gap-2">
        <UButton size="sm" variant="soft" data-action="scroll-middle" @click="scrollToMiddle">
          Scroll to middle
        </UButton>
        <UButton size="sm" variant="soft" data-action="scroll-end" @click="scrollToEnd">
          Scroll to end
        </UButton>
        <UButton size="sm" color="primary" data-action="prepend-100" @click="prependOneHundred">
          Prepend 100
        </UButton>
        <UButton size="sm" variant="ghost" data-action="recount" @click="recountMountedRows">
          Recount mounted rows
        </UButton>
      </div>
      <div v-if="lastProof" class="rounded-md border border-default bg-elevated p-3 text-xs space-y-1" data-proof>
        <div data-proof-before>before: scrollTop={{ lastProof.before.scrollTop }} text="{{ lastProof.before.topRowText.slice(0, 40) }}"</div>
        <div data-proof-after>after: scrollTop={{ lastProof.after.scrollTop }} text="{{ lastProof.after.topRowText.slice(0, 40) }}"</div>
        <div data-proof-delta>heightDelta={{ lastProof.heightDelta }} scrollTopDelta={{ lastProof.scrollTopDelta }} same-row={{ lastProof.same }}</div>
      </div>
    </div>

    <div
      ref="scrollParent"
      class="relative h-[70vh] overflow-y-auto rounded-md border border-default bg-default"
      data-scroll-root
    >
      <div :style="{ height: `${totalSize}px`, position: 'relative', width: '100%' }">
        <div
          v-for="row in virtualRows"
          :key="String(row.key)"
          :ref="measureRow"
          :data-index="row.index"
          :data-vrow="row.key"
          :data-start="row.start"
          class="absolute left-0 top-0 w-full border-b border-muted px-3 py-2 text-sm text-default"
          :style="{ transform: `translateY(${row.start}px)` }"
        >
          #{{ row.index }} ({{ row.key }}) {{ rows[row.index]?.text }}
        </div>
      </div>
    </div>

    <!-- ══════════════════════════════════════════════════════════════════════════════
         Task 7 (cycle 66): SessionsTranscriptRow — one of each row shape from the brief.
         ══════════════════════════════════════════════════════════════════════════════ -->
    <div class="space-y-2 border-t border-default pt-8" data-transcript-rows>
      <h2 class="text-lg font-semibold text-highlighted">
        SessionsTranscriptRow shapes
      </h2>
      <p class="text-sm text-muted">
        short user &middot; long (clampable) assistant &middot; thinking &middot; tool ok &middot;
        tool error &middot; tool with object result &middot; sidechain &middot; 300,000-char body
      </p>
      <div class="divide-y divide-default rounded-md border border-default bg-default px-3">
        <div v-for="m in rowMessages" :key="m.id" :data-row-id="m.id">
          <SessionsTranscriptRow :message="m" :tool-events="toolEventsFor(m.id)" />
        </div>
      </div>
    </div>
  </div>
</template>
