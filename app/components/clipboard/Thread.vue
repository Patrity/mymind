<script setup lang="ts">
// Thread view. Loads only the newest page of history on mount (so prod doesn't
// pull the whole thread), snaps to the bottom, then lazy-loads older messages
// as the user scrolls up — with skeleton placeholders while a page is in flight.
// `useThreadStream` keeps live arrivals flowing (SSE with polling fallback); we
// dedupe on `id` since a catch-up replay can overlap what we already hold.
//
// Message bodies render through MDC (markdown), which grows the DOM *after*
// mount — so scrollHeight math the moment a page renders is unreliable. Instead
// a ResizeObserver re-applies the desired scroll position (pinned to the bottom,
// or anchored to a message) every time the content resizes, which stays correct
// as the markdown settles.
//
// Adapted from copipasta: removed multi-user device list fetch (no /api/devices
// endpoint in MyMind), removed lastThreadId PATCH call (single-thread model),
// removed auth guards (MyMind handles auth globally).
interface AttachmentRow {
  storageKey: string
  sha256: string
  size: number
  mime: string
  originalName: string
  width: number | null
  height: number | null
}
interface MessageRow {
  id: string
  deviceId: string
  deviceLabel?: string | null
  kind: 'text' | 'file'
  bodyText: string | null
  bodyHtml: string | null
  createdAt: string | Date | number
  attachment?: AttachmentRow
}

// Newest page loaded on mount; same size used for each scroll-up page.
const PAGE_SIZE = 10
// Trigger an older-page fetch when within this many px of the top.
const TOP_THRESHOLD_PX = 120
// Treat the user as "at the bottom" (so live arrivals auto-scroll) within this.
const BOTTOM_STICK_PX = 120

const props = defineProps<{ threadId: string }>()
const toast = useToast()

const messages = ref<MessageRow[]>([])
const loadingInitial = ref(true)
const loadingOlder = ref(false)
const hasMore = ref(false)
const scroller = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)

// Newest createdAt we hold — seeds the stream's poll cursor so the polling
// fallback only asks for messages newer than what we already rendered.
const newestCursor = ref<string | null>(null)

// Current device id from the long-lived cookie set by /api/clipboard/devices/register.
const currentDeviceId = useCookie<string | null>('clip_device')

// --- scroll-position controller ---------------------------------------------
// `bottom` keeps the newest message in view; `anchor` holds a specific message
// in place while older content prepends above it; `none` leaves the user alone.
type ScrollMode =
  | { kind: 'bottom' }
  | { kind: 'none' }
  | { kind: 'anchor', el: HTMLElement, offsetTop: number, scrollTop: number }
let scrollMode: ScrollMode = { kind: 'bottom' }
// Programmatic scrollTop writes fire `scroll` events; ignore them for a short
// window so onScroll doesn't mistake our own correction (a transient mid-render
// position) for the user scrolling away and release the pin too early.
let suppressScrollUntil = 0

function applyScrollMode() {
  const el = scroller.value
  if (!el) return
  let target: number | null = null
  if (scrollMode.kind === 'bottom') target = el.scrollHeight
  else if (scrollMode.kind === 'anchor') target = scrollMode.scrollTop + (scrollMode.el.offsetTop - scrollMode.offsetTop)
  if (target == null) return
  if (Math.abs(target - el.scrollTop) > 1) {
    el.scrollTop = target
    suppressScrollUntil = performance.now() + 150
  }
}

function toIso(v: string | Date | number): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'number') return new Date(v).toISOString()
  return v
}

function syncCursor() {
  const newest = messages.value.at(-1)
  newestCursor.value = newest ? toIso(newest.createdAt) : null
}

// Fetch the page of messages immediately older than what we hold. Returns the
// de-duped new rows (the cursor row is re-fetched by design — see the server's
// `before` handling — so we filter ids we already have).
async function fetchOlder(): Promise<MessageRow[]> {
  const oldest = messages.value[0]
  if (!oldest) return []
  const rows = await $fetch<MessageRow[]>(`/api/clipboard/threads/${props.threadId}/messages`, {
    query: { before: toIso(oldest.createdAt), limit: PAGE_SIZE }
  })
  hasMore.value = rows.length === PAGE_SIZE
  const existing = new Set(messages.value.map(m => m.id))
  return rows.filter(m => !existing.has(m.id))
}

async function loadInitial() {
  loadingInitial.value = true
  scrollMode = { kind: 'bottom' }
  try {
    const rows = await $fetch<MessageRow[]>(`/api/clipboard/threads/${props.threadId}/messages`, {
      query: { limit: PAGE_SIZE }
    })
    messages.value = rows
    hasMore.value = rows.length === PAGE_SIZE
    syncCursor()
  } catch (e) {
    toast.add({ title: 'Could not load messages', description: errMsg(e), color: 'error' })
  } finally {
    loadingInitial.value = false
  }
  // The ResizeObserver (attached once `content` mounts) keeps us pinned to the
  // bottom as the markdown renders; nudge once now for the first frame.
  await nextTick()
  applyScrollMode()
}

// User-driven scroll-up: hold the current top message in place while the older
// page (and its async markdown) prepends above it.
async function loadOlder() {
  if (!hasMore.value || loadingOlder.value || loadingInitial.value) return
  const el = scroller.value
  if (!el || !messages.value.length) return

  loadingOlder.value = true
  try {
    const fresh = await fetchOlder()
    if (fresh.length) {
      const firstEl = el.querySelector<HTMLElement>('[id^=message-]')
      if (firstEl) {
        scrollMode = { kind: 'anchor', el: firstEl, offsetTop: firstEl.offsetTop, scrollTop: el.scrollTop }
      }
      messages.value = [...fresh, ...messages.value]
    }
  } catch (e) {
    toast.add({ title: 'Could not load older messages', description: errMsg(e), color: 'error' })
  } finally {
    loadingOlder.value = false
    await nextTick()
    applyScrollMode()
    // Release the anchor once the prepended markdown has settled, so the user
    // can scroll freely again.
    window.setTimeout(() => { if (scrollMode.kind === 'anchor') scrollMode = { kind: 'none' } }, 500)
  }
}

// When the newest page doesn't overflow the viewport there's no scrollbar to
// pull older pages with — keep loading until the thread is scrollable (or we
// run out). We stay pinned to the bottom throughout.
async function fillViewport() {
  scrollMode = { kind: 'bottom' }
  let guard = 0
  while (guard++ < 20 && hasMore.value && !loadingOlder.value) {
    await settle()
    const el = scroller.value
    if (!el || el.scrollHeight > el.clientHeight + TOP_THRESHOLD_PX) break
    loadingOlder.value = true
    try {
      const fresh = await fetchOlder()
      if (fresh.length) messages.value = [...fresh, ...messages.value]
    } catch {
      hasMore.value = false
    } finally {
      loadingOlder.value = false
    }
    await nextTick()
    applyScrollMode()
  }
}

function onScroll() {
  const el = scroller.value
  if (!el) return
  if (performance.now() < suppressScrollUntil) return // our own correction, not the user
  // Track whether the user is parked at the bottom (so live arrivals stick) or
  // has scrolled away (leave them be) — but never override an in-flight anchor.
  if (scrollMode.kind !== 'anchor') {
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    scrollMode = dist < BOTTOM_STICK_PX ? { kind: 'bottom' } : { kind: 'none' }
  }
  if (el.scrollTop <= TOP_THRESHOLD_PX) void loadOlder()
}

// Re-apply the desired scroll position whenever the rendered content resizes
// (markdown finishing, images loading, a page prepending).
watch(content, (el, _old, onCleanup) => {
  if (!el || typeof ResizeObserver === 'undefined') return
  const obs = new ResizeObserver(() => applyScrollMode())
  obs.observe(el)
  onCleanup(() => obs.disconnect())
})

onMounted(async () => {
  await loadInitial()
  await fillViewport()
})

// Live stream. The composable handles SSE → polling fallback; we dedupe and
// append. Pinning to the bottom is handled by the ResizeObserver when the user
// is already at the bottom (mode 'bottom'); if they've scrolled up we don't yank.
useThreadStream(computed(() => props.threadId), (m) => {
  const cast = m as unknown as MessageRow
  if (messages.value.find(x => x.id === cast.id)) return
  messages.value.push(cast)
  syncCursor()
  nextTick(applyScrollMode)
}, newestCursor)

// Group consecutive messages from the same device. When the previous message
// has the same deviceId AND was sent within a few minutes, the bubble
// suppresses its caption to reduce visual noise.
const CAPTION_GAP_MS = 5 * 60 * 1000

function shouldShowCaption(index: number): boolean {
  if (index === 0) return true
  const prev = messages.value[index - 1]
  const cur = messages.value[index]
  if (!prev || !cur || prev.deviceId !== cur.deviceId) return true
  const prevMs = prev.createdAt instanceof Date ? prev.createdAt.getTime() : Number(prev.createdAt)
  const curMs = cur.createdAt instanceof Date ? cur.createdAt.getTime() : Number(cur.createdAt)
  return Math.abs(curMs - prevMs) > CAPTION_GAP_MS
}

// --- helpers ---
function errMsg(e: unknown): string | undefined {
  const err = e as { data?: { statusMessage?: string }, message?: string }
  return err.data?.statusMessage ?? err.message
}
// Wait two frames so layout reflects the latest render before we measure.
function settle(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}
</script>

<template>
  <div
    ref="scroller"
    class="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col"
    @scroll="onScroll"
  >
    <!-- Initial load: skeleton bubbles pinned to the bottom. -->
    <div v-if="loadingInitial" class="mt-auto flex flex-col gap-3">
      <USkeleton
        v-for="n in 6"
        :key="`init-${n}`"
        class="h-12 rounded-lg"
        :class="n % 2 ? 'w-2/3 mr-auto' : 'w-1/2 ml-auto'"
      />
    </div>

    <!-- Empty thread. -->
    <div
      v-else-if="!messages.length"
      class="m-auto flex flex-col items-center justify-center text-center gap-2 text-muted"
    >
      <UIcon name="i-lucide-clipboard-paste" class="size-10 text-dimmed" />
      <p class="text-sm">
        Nothing yet. Paste, type, or drop a file below.
      </p>
    </div>

    <!-- History. `mt-auto` keeps a short thread pinned to the bottom; once it
         overflows the margin collapses and it scrolls normally. -->
    <div v-else ref="content" class="mt-auto">
      <!-- Older-page loader: skeletons above the history while it streams in. -->
      <div v-if="loadingOlder" class="flex flex-col gap-3 pb-3">
        <USkeleton
          v-for="n in 3"
          :key="`older-${n}`"
          class="h-10 rounded-lg"
          :class="n % 2 ? 'w-1/2 mr-auto' : 'w-2/3 ml-auto'"
        />
      </div>

      <template v-for="(m, i) in messages" :key="m.id">
        <ClipboardMessageBubble
          :message="m"
          :current-device-id="currentDeviceId ?? null"
          :show-caption="shouldShowCaption(i)"
          :class="shouldShowCaption(i) ? 'mt-4 first:mt-0' : 'mt-0.5'"
        />
      </template>
    </div>
  </div>
</template>
