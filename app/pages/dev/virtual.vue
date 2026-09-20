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
  </div>
</template>
