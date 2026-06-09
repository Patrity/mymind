// server/lib/agent/bus.ts
import { EventEmitter } from 'node:events'
import type { ActivityEvent } from './types'

const emitter = new EventEmitter()
emitter.setMaxListeners(0)
const CHANNEL = 'agent-activity'

export function publishActivity(e: ActivityEvent): void {
  emitter.emit(CHANNEL, e)
}

export function subscribeActivity(cb: (e: ActivityEvent) => void): () => void {
  emitter.on(CHANNEL, cb)
  return () => emitter.off(CHANNEL, cb)
}
