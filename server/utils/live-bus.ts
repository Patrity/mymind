import { EventEmitter } from 'node:events'
import type { LiveEvent } from '../../shared/types/live'

// Single in-process global channel for data-change signals. Same pattern as
// server/lib/agent/bus.ts. setMaxListeners(0) removes the 10-listener cap —
// one listener per open SSE connection (tab/device). Single-instance (no Redis)
// is correct for this homelab app. Future multi-user: add a `scope` arg here and
// a topic filter in subscribeChanges; nothing else changes.
const emitter = new EventEmitter()
emitter.setMaxListeners(0)
const CHANNEL = 'live-change'

export function publishChange(e: Pick<LiveEvent, 'resource' | 'action' | 'id'>): void {
  // `satisfies` locks the shape: a future `v: 2` mistake fails to typecheck here.
  const event = { v: 1, at: Date.now(), ...e } satisfies LiveEvent
  emitter.emit(CHANNEL, event)
}

export function subscribeChanges(cb: (e: LiveEvent) => void): () => void {
  emitter.on(CHANNEL, cb)
  return () => emitter.off(CHANNEL, cb)
}
