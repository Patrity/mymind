export interface Emitter<E> {
  on: (cb: (e: E) => void) => () => void
  emit: (e: E) => void
}

export function createEmitter<E>(): Emitter<E> {
  const subs = new Set<(e: E) => void>()
  return {
    on(cb) { subs.add(cb); return () => { subs.delete(cb) } },
    // copy so unsubscribing mid-emit can't skip a subscriber
    emit(e) { for (const cb of [...subs]) cb(e) },
  }
}
