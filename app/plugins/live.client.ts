import type { QueryClient } from '@tanstack/vue-query'
import { authClient } from '../lib/auth-client'
import { dispatchLiveEvent } from '../utils/live-dispatch'
import type { LiveEvent } from '../../shared/types/live'

// dependsOn guarantees the vue-query plugin has run and provided `$queryClient`
// before this plugin opens the SSE stream. Without it, this plugin (filename sorts
// before 'vue-query') would run first and find no QueryClient.
export default defineNuxtPlugin({
  name: 'live-sse',
  dependsOn: ['vue-query'],
  setup(nuxt) {
    const queryClient = nuxt.$queryClient as QueryClient
    let es: EventSource | null = null

    function openStream() {
      if (es) return
      es = new EventSource('/api/events')
      es.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data) as LiveEvent
          if (data?.resource && data?.id) dispatchLiveEvent(queryClient, data)
        } catch { /* ignore heartbeat/comment frames */ }
      }
      // EventSource reconnects automatically on transient errors; no manual loop needed.
    }

    function disconnect() {
      es?.close()
      es = null
    }

    // Gate on the actual session, not the route: /api/events 401s without a session,
    // and the browser would log that error. Checking getSession() before opening the
    // stream avoids a stray connect during the unauthenticated → /login redirect race.
    async function syncToSession() {
      const { data } = await authClient.getSession()
      if (data?.session) openStream()
      else disconnect()
    }

    syncToSession()
    // Re-evaluate after each navigation so the stream opens right after sign-in and
    // closes on sign-out (both change the route).
    useRouter().afterEach(() => { syncToSession() })

    if (import.meta.hot) import.meta.hot.dispose(disconnect)
  }
})
