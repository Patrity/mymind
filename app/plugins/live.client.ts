import { useQueryClient } from '@tanstack/vue-query'
import { dispatchLiveEvent } from '../utils/live-dispatch'
import type { LiveEvent } from '../../shared/types/live'

export default defineNuxtPlugin(() => {
  const queryClient = useQueryClient()
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
})
