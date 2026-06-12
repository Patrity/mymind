import type { QueryClient } from '@tanstack/vue-query'
import { dispatchLiveEvent } from '../utils/live-dispatch'
import type { LiveEvent } from '../../shared/types/live'

// dependsOn guarantees the vue-query plugin has run and provided `$queryClient`
// before this plugin opens the SSE stream. Without it, this plugin (filename sorts
// before 'vue-query') would run first and find no QueryClient.
export default defineNuxtPlugin({
  name: 'live-sse',
  dependsOn: ['vue-query'],
  setup(nuxt) {
    // Provided by the 'vue-query' plugin (guaranteed present via dependsOn).
    const queryClient = nuxt.$queryClient as QueryClient
    let es: EventSource | null = null

    function connect() {
      es = new EventSource('/api/events')
      es.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data) as LiveEvent
          if (data?.resource && data?.id) dispatchLiveEvent(queryClient, data)
        } catch { /* ignore heartbeat/comment frames */ }
      }
      // EventSource reconnects automatically on transient errors; no manual loop needed.
    }

    connect()

    if (import.meta.hot) import.meta.hot.dispose(() => es?.close())
  }
})
