// server/lib/agent/bus.ts
import { EventEmitter } from 'node:events'
import type { ActivityEvent } from './types'
import { currentEvalScope } from '../eval/context'

const emitter = new EventEmitter()
emitter.setMaxListeners(0)
const CHANNEL = 'agent-activity'

export function publishActivity(e: ActivityEvent): void {
  // Cycle 85: an eval world's activity (thinking / tool chips) never reaches Tony's activity feed.
  const scope = currentEvalScope()
  if (scope) { scope.suppressLive('activity', e); return }
  emitter.emit(CHANNEL, e)
}

export function subscribeActivity(cb: (e: ActivityEvent) => void): () => void {
  emitter.on(CHANNEL, cb)
  return () => emitter.off(CHANNEL, cb)
}
