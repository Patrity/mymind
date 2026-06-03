import { EventEmitter } from 'node:events'

// In-process pub/sub for clipboard SSE streaming. Scoped per thread via the
// `t:<threadId>` event name. `setMaxListeners(0)` removes the default 10-listener
// cap — a thread may have many open SSE connections (one per tab/device).
// Single-instance (no Redis) is fine for a personal homelab; scale follow-up is noted.
const emitter = new EventEmitter()
emitter.setMaxListeners(0)

export function publish(threadId: string, data: unknown): void {
  emitter.emit(`t:${threadId}`, data)
}

export function subscribe(threadId: string, cb: (data: unknown) => void): () => void {
  emitter.on(`t:${threadId}`, cb)
  return () => emitter.off(`t:${threadId}`, cb)
}
