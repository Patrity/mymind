<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useIntersectionObserver, useResizeObserver } from '@vueuse/core'
import type { SessionMessageDTO, SessionToolEventDTO } from '~~/shared/types/session'
import { anchorAfterPrepend } from './anchor'

const props = defineProps<{
  /** OLDEST-FIRST, ready to render. The parent owns paging and un-reverses the API's pages. */
  messages: SessionMessageDTO[]
  toolEvents: SessionToolEventDTO[]
  loading?: boolean
  /** An older page exists. Drives the top sentinel. */
  hasMore?: boolean
  fetchingMore?: boolean
  /** The last older-page fetch failed. The sentinel becomes a retry row; rows STAY on screen. */
  error?: boolean
}>()

const emit = defineEmits<{ 'load-more': [] }>()

// ── Tool events ───────────────────────────────────────────────────────────────
const toolEventsByMsg = computed(() => {
  const m = new Map<string, SessionToolEventDTO[]>()
  for (const te of props.toolEvents ?? []) {
    if (!te.messageId) continue
    const arr = m.get(te.messageId) ?? []
    arr.push(te)
    m.set(te.messageId, arr)
  }
  return m
})

function toolEventsFor(id: string | undefined): SessionToolEventDTO[] {
  return (id && toolEventsByMsg.value.get(id)) || []
}

// ── Virtualization ────────────────────────────────────────────────────────────
// Only the visible window of rows is mounted, and each row is MEASURED (rows vary wildly:
// a one-line user turn vs. an expanded tool call). Pattern proven in the Task 0 spike
// (`app/pages/dev/virtual.vue`).
const scrollRoot = ref<HTMLElement | null>(null)
const topSentinel = ref<HTMLElement | null>(null)
const spacer = ref<HTMLElement | null>(null)

const ROW_ESTIMATE = 140
const BOTTOM_THRESHOLD = 80
/** Start the next page before the reader hits the literal top. */
const SENTINEL_MARGIN = 300

// The options must be a computed for the virtualizer to react to `messages` changing — a
// plain object would never re-run on a prepend.
const virtualizerOptions = computed(() => ({
  count: props.messages.length,
  getScrollElement: () => scrollRoot.value,
  estimateSize: () => ROW_ESTIMATE,
  overscan: 10,
  // Stable, id-based keys (NOT index) so the measurement cache survives a prepend: the row
  // that was at index 0 keeps its measured height even though its index shifts by a page.
  getItemKey: (index: number) => props.messages[index]?.id ?? index,
  onChange: onVirtualizerChange
}))

const virtualizer = useVirtualizer(virtualizerOptions)
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

function measureRow(el: Element | ComponentPublicInstance | null) {
  if (!el || !(el instanceof HTMLElement)) return
  virtualizer.value.measureElement(el)
}

// ── The virtualizer's own completion signal ───────────────────────────────────
// Setting `el.scrollTop` does NOT update the virtualizer synchronously: it reacts to the
// native, asynchronous `scroll` event, not to Vue's render tick. Reading state one tick after
// the assignment reports the PRE-correction layout (this is what made the Task 0 spike's first
// attempt look broken despite correct arithmetic). `onChange` is the library telling us it has
// processed the change — so wait for that, with a two-frame fallback for the case where the
// write was a no-op (delta 0 fires no scroll event, so no onChange ever comes).
let changeWaiters: Array<() => void> = []
function onVirtualizerChange() {
  if (!changeWaiters.length) return
  const waiters = changeWaiters
  changeWaiters = []
  for (const w of waiters) w()
}

function waitForVirtualizerChange(): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    changeWaiters.push(finish)
    if (import.meta.client) requestAnimationFrame(() => requestAnimationFrame(finish))
    else finish()
  })
}

// ── Scroll anchoring on prepend ───────────────────────────────────────────────
interface Anchor { scrollTop: number, prevScrollHeight: number }

async function restoreAfterPrepend(cap: Anchor) {
  const el = scrollRoot.value
  if (!el) return
  // One tick for the virtualizer's options watcher + the re-render it triggers (new rows mount
  // and measure themselves), a second for the re-render those measurements queue (corrected
  // total size / transforms) to land — only then is `scrollHeight` the post-prepend height.
  await nextTick()
  await nextTick()
  const target = anchorAfterPrepend({
    scrollTop: cap.scrollTop,
    prevScrollHeight: cap.prevScrollHeight,
    nextScrollHeight: el.scrollHeight
  })
  el.scrollTop = target
  await waitForVirtualizerChange()
  // Re-derives atBottom and, if the reader is still near the top, asks for the next page.
  // Rows above the fold that were still estimated get measured as they render; virtual-core
  // compensates scrollTop for those itself (first-measure adjustment), so nothing more to do.
  onLocalScroll()
}

// ── Autoscroll + live-tail ────────────────────────────────────────────────────
const atBottom = ref(true)
const followTail = ref(true)
const lastSeenId = ref<string | null>(null)
const initialScrollDone = ref(false)

// Rows are measured lazily, so one write to the bottom lands on an ESTIMATED total height and
// the corrections that follow leave the viewport short of the real bottom (measured: 117px
// short, which is enough to read as "not at bottom" and disable live-tail follow). So re-pin
// until the gap has stayed closed across a few of the virtualizer's own change signals.
//
// `virtualizer.scrollToIndex` has its own reconcile loop for this, but it keeps re-targeting
// the end for up to 5s and yanks a reader who scrolled away in the meantime. Instead: a short
// deadline, and an abort on the unambiguous signals that the reader has taken over.
const PIN_WINDOW_MS = 1200
/** How long after a pin a late-growing row still counts as "content we were following". */
const FOLLOW_WINDOW_MS = 2500
let scrollGen = 0
let pinUntil = 0

// The rows render their bodies asynchronously (markdown, code blocks), so the list can keep
// growing AFTER the pin loop has seen a closed gap — measured: the total grew 117px 140ms
// later, leaving the transcript just far enough off the bottom to disable live-tail follow.
// The spacer IS the virtualizer's total size, so watching it catches exactly that growth.
// Time-boxed, so expanding a row minutes later never drags the viewport.
useResizeObserver(spacer, () => {
  const el = scrollRoot.value
  if (!el || !followTail.value || Date.now() > pinUntil) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight <= 1) return
  el.scrollTop = el.scrollHeight
})

async function scrollToBottom() {
  const gen = ++scrollGen
  const el = scrollRoot.value
  if (!el || !props.messages.length) return
  // Every caller of this is a request to follow the tail: the first render, a new message
  // arriving while already pinned, or the reader pressing "N new".
  followTail.value = true
  pinUntil = Date.now() + FOLLOW_WINDOW_MS
  // Per-invocation controller and handler identity. A shared handler reference would be
  // deduplicated by addEventListener, so an overlapping second pin would silently inherit the
  // first registration — and then whichever call finished first would strip the LIVE pin's
  // abort, leaving it unstoppable for its whole window. The signal also removes both
  // listeners on abort, so there is one teardown path instead of two.
  const ac = new AbortController()
  const readerTookOver = () => {
    // Reader intent, recorded where every other part of this component already reads it.
    followTail.value = false
    ac.abort()
  }
  const listen = { passive: true, capture: true, signal: ac.signal } as const
  el.addEventListener('wheel', readerTookOver, listen)
  el.addEventListener('touchstart', readerTookOver, listen)
  try {
    const deadline = Date.now() + PIN_WINDOW_MS
    let quiet = 0
    // `followTail` in the condition is what stops the pin for the ways of scrolling away that
    // fire no wheel and no touch event at all: the keyboard (Page Up, arrows) and dragging the
    // scrollbar. Both still fire `scroll`, and onLocalScroll turns that into followTail=false.
    while (Date.now() < deadline && !ac.signal.aborted && followTail.value && gen === scrollGen) {
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) {
        el.scrollTop = el.scrollHeight
        quiet = 0
      } else if (++quiet >= 3) {
        break
      }
      await waitForVirtualizerChange()
      await nextTick()
    }
  } finally {
    ac.abort()
  }
  if (gen !== scrollGen) return
  // onLocalScroll re-derives atBottom/followTail from where we actually ended up — including
  // the aborted case, where the reader is now somewhere up the transcript and owns it.
  onLocalScroll()
}

function onLocalScroll() {
  const el = scrollRoot.value
  if (!el) return
  atBottom.value = isAtBottom({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight
  }, BOTTOM_THRESHOLD)
  // A reader who scrolls up owns the viewport until they come back.
  followTail.value = atBottom.value
  maybeRequestOlder()
}

function markSeen() {
  lastSeenId.value = props.messages.at(-1)?.id ?? null
}

function jumpToLatest() {
  scrollToBottom()
  markSeen()
}

const newCount = computed(() => countNewSince(props.messages, lastSeenId.value))

// Classify each change to `messages` BEFORE the DOM updates (flush: 'pre'), so the pre-prepend
// scrollTop/scrollHeight are the real ones — capturing them at emit time instead would fold in
// anything that happened during the fetch.
watch(
  () => props.messages,
  (next, prev) => {
    const el = scrollRoot.value
    const grew = next.length > (prev?.length ?? 0)
    const firstChanged = next[0]?.id !== prev?.[0]?.id
    const lastChanged = next.at(-1)?.id !== prev?.at(-1)?.id

    if (!prev?.length && next.length) {
      void afterRender(() => {
        scrollToBottom()
        markSeen()
        initialScrollDone.value = true
      })
      return
    }
    if (el && grew && firstChanged) {
      const cap: Anchor = { scrollTop: el.scrollTop, prevScrollHeight: el.scrollHeight }
      void restoreAfterPrepend(cap)
      return
    }
    if (grew && lastChanged && followTail.value) {
      void afterRender(() => {
        scrollToBottom()
        markSeen()
      })
    }
  },
  { flush: 'pre' }
)

async function afterRender(fn: () => void) {
  await nextTick()
  await nextTick()
  fn()
}

// ── Older-page paging ─────────────────────────────────────────────────────────
// One request per distinct list length: the emit is idempotent until a page actually lands
// (which changes the length), so overlapping scroll/observer triggers can't stack up fetches.
let requestedAtLength = -1

function maybeRequestOlder() {
  if (!props.hasMore || props.fetchingMore || props.error) return
  // Don't page while the first render is still scrolling to the bottom — the sentinel is
  // trivially "visible" at that moment.
  if (!initialScrollDone.value) return
  if (props.messages.length === requestedAtLength) return
  const el = scrollRoot.value
  const s = topSentinel.value
  if (!el || !s) return
  if (s.getBoundingClientRect().bottom < el.getBoundingClientRect().top - SENTINEL_MARGIN) return
  requestedAtLength = props.messages.length
  emit('load-more')
}

// Two triggers, deliberately. The observer catches a reader arriving at the top; the scroll
// handler catches the cases it structurally cannot: IntersectionObserver only fires on
// CHANGES and delivers asynchronously, so a sentinel that never leaves the viewport, or one
// that leaves again before delivery (virtual-core corrects scrollTop after measuring rows
// following a jump — measured: a 250px jump landed at 599px, past the trigger zone), stalls
// paging with no way to recover but more scrolling.
useIntersectionObserver(
  topSentinel,
  ([entry]) => {
    if (!entry?.isIntersecting) return
    maybeRequestOlder()
  },
  { root: scrollRoot, rootMargin: `${SENTINEL_MARGIN}px 0px 0px 0px` }
)

function retry() {
  if (props.fetchingMore) return
  requestedAtLength = -1
  emit('load-more')
}

// Messages can be there on the very first render (a warm query cache), in which case the
// watcher above never sees an "arrival" — without this, paging would never unlock.
onMounted(() => {
  if (!props.messages.length || initialScrollDone.value) return
  void afterRender(() => {
    scrollToBottom()
    markSeen()
    initialScrollDone.value = true
  })
})
</script>

<template>
  <div class="space-y-2 h-full flex flex-col relative">
    <h2 class="text-sm font-semibold text-muted uppercase tracking-wider px-1 shrink-0">
      Transcript
    </h2>

    <!-- Loading skeleton (outside the virtual list) -->
    <div
      v-if="loading && !messages.length"
      class="space-y-2 h-full overflow-y-auto pr-1"
    >
      <USkeleton
        v-for="i in 5"
        :key="i"
        class="h-24 w-full rounded-lg"
      />
    </div>

    <!-- Empty transcript (outside the virtual list) -->
    <div
      v-else-if="!loading && !messages.length"
      class="flex flex-col items-center justify-center py-16 gap-3 text-center h-full overflow-y-auto pr-1"
    >
      <UIcon
        name="i-lucide-message-square-off"
        class="size-10 text-muted"
      />
      <p class="text-sm text-muted">
        No messages in this session
      </p>
    </div>

    <!-- Virtualized scroll area fills the pane: only the visible window is mounted -->
    <div
      v-else
      ref="scrollRoot"
      class="h-full overflow-y-auto pr-1"
      data-transcript-scroll
      style="overflow-anchor: none"
      @scroll="onLocalScroll"
    >
      <!-- Older-page sentinel, ABOVE the rows: reaching the top loads the previous page, and a
           failed page turns it into a retry row without touching the rows already loaded.
           `min-h-12` holds both states at the same height so swapping the spinner for the retry
           row doesn't push the rows below it down (measured: 8px of drift before it was pinned). -->
      <div
        v-if="hasMore || error"
        ref="topSentinel"
        data-transcript-sentinel
        class="flex items-center justify-center gap-2 py-3 min-h-12"
      >
        <template v-if="error">
          <UIcon
            name="i-lucide-triangle-alert"
            class="size-4 text-error shrink-0"
          />
          <span class="text-xs text-muted">Couldn't load older messages</span>
          <UButton
            label="Retry"
            color="neutral"
            variant="subtle"
            size="xs"
            :loading="fetchingMore"
            data-transcript-retry
            @click="retry"
          />
        </template>
        <template v-else-if="fetchingMore">
          <UIcon
            name="i-lucide-loader-circle"
            class="size-4 text-muted animate-spin"
          />
          <span class="text-xs text-muted">Loading older messages…</span>
        </template>
        <template v-else>
          <UIcon
            name="i-lucide-chevron-up"
            class="size-4 text-dimmed"
          />
          <span class="text-xs text-dimmed">Older messages</span>
        </template>
      </div>

      <div
        ref="spacer"
        :style="{ height: `${totalSize}px`, position: 'relative', width: '100%' }"
      >
        <div
          v-for="row in virtualRows"
          :key="String(row.key)"
          :ref="measureRow"
          :data-index="row.index"
          :data-vrow="row.key"
          :data-start="row.start"
          data-msg
          class="absolute left-0 top-0 w-full"
          :style="{ transform: `translateY(${row.start}px)` }"
        >
          <SessionsTranscriptRow
            v-if="messages[row.index]"
            :message="messages[row.index]!"
            :tool-events="toolEventsFor(messages[row.index]?.id)"
          />
        </div>
      </div>
    </div>

    <!-- Live-tail affordance: appears when new messages arrived while scrolled up -->
    <UButton
      v-if="!atBottom && newCount > 0"
      icon="i-lucide-arrow-down"
      color="primary"
      size="sm"
      class="absolute bottom-4 right-4 shadow-lg"
      :label="`${newCount} new`"
      @click="jumpToLatest"
    />
  </div>
</template>
