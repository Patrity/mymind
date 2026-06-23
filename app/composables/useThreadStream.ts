import type { Ref } from 'vue'

interface MessageRow {
  id: string
  [key: string]: unknown
}

// SSE constants (inlined — no shared constants file in MyMind).
const SSE_INITIAL_GRACE_MS = 2000
const POLL_INTERVAL_MS = 4000

// Subscribes to a thread's live message stream via native EventSource. The
// browser handles `Last-Event-ID` reconnects for us; we only intervene when
// SSE looks definitively dead — either it never opened (the initial-grace
// window) or it has flapped > 5 times inside a minute. In both cases we fall
// back to polling `/api/clipboard/threads/:id/messages?since=...` forever;
// SSE is not retried once we've gone cold-fallback.
//
// Adapted from copipasta: API base → /api/clipboard/threads/*. Logic unchanged.
// `initialCursor` seeds the forward-poll cursor with the newest message the
// caller already loaded, so the polling fallback asks only for messages *after*
// that point. Without it, the first poll sends `since=''`, which the API treats
// as "newest page" and would replay a whole page of history into onMessage.
export function useThreadStream(
  threadId: Ref<string>,
  onMessage: (m: MessageRow) => void,
  initialCursor?: Ref<string | null>
) {
  let es: EventSource | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  // FIX 3: Track a timestamp cursor (ISO string) instead of a UUID id so that
  // listMessages' `gt(createdAt, new Date(since))` receives a parseable value.
  let lastCreatedAt: string | null = null
  // Dedup set so a message isn't shown twice when SSE and poll overlap.
  const seenIds = new Set<string>()
  let reconnectTimes: number[] = []
  let pollingPermanent = false

  function startPolling() {
    if (pollTimer) return
    pollingPermanent = true
    pollTimer = setInterval(async () => {
      try {
        const since = lastCreatedAt ?? initialCursor?.value ?? ''
        const r = await $fetch<MessageRow[]>(`/api/clipboard/threads/${threadId.value}/messages`, {
          query: { since }
        })
        for (const m of r) {
          if (seenIds.has(m.id)) continue
          seenIds.add(m.id)
          if (typeof m.createdAt === 'string') lastCreatedAt = m.createdAt
          onMessage(m)
        }
      } catch {
        // Swallow transient errors — next tick will retry.
      }
    }, POLL_INTERVAL_MS)
  }

  function startSSE() {
    if (pollingPermanent) return
    const url = `/api/clipboard/threads/${threadId.value}/stream`
    // `withCredentials` keeps the auth + device cookies on cross-origin builds.
    es = new EventSource(url, { withCredentials: true } as EventSourceInit)
    const openedAt = Date.now()
    let opened = false
    es.onopen = () => {
      opened = true
    }
    es.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data) as MessageRow
        if (seenIds.has(m.id)) return
        seenIds.add(m.id)
        if (typeof m.createdAt === 'string') lastCreatedAt = m.createdAt
        onMessage(m)
      } catch {
        // Ignore non-JSON frames (e.g. heartbeat comments).
      }
    }
    es.onerror = () => {
      // Never opened and we're inside the grace window → server probably
      // doesn't speak SSE at all (proxy, ad-blocker, browser without EVS).
      // Fall back to polling immediately.
      if (!opened && Date.now() - openedAt < SSE_INITIAL_GRACE_MS) {
        es?.close()
        startPolling()
        return
      }
      // Flap detection: > 5 errors inside a rolling 60s window ⇒ give up on
      // SSE and switch to polling permanently.
      const now = Date.now()
      reconnectTimes = reconnectTimes.filter(t => now - t < 60_000)
      reconnectTimes.push(now)
      if (reconnectTimes.length > 5) {
        es?.close()
        startPolling()
      }
      // Otherwise: let the browser's native EventSource handle reconnect with
      // its built-in backoff + Last-Event-ID header.
    }
  }

  onMounted(() => {
    startSSE()
  })
  onUnmounted(() => {
    es?.close()
    if (pollTimer) clearInterval(pollTimer)
  })
  // Re-open when the caller switches threads. Reset all per-thread state so we
  // don't carry the previous thread's cursor or flap count into the new one.
  watch(threadId, () => {
    es?.close()
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    pollingPermanent = false
    reconnectTimes = []
    lastCreatedAt = null
    seenIds.clear()
    startSSE()
  })
}
