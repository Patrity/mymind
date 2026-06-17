/** True when the scroll position is within `threshold` px of the bottom. Pure. */
export function isAtBottom(s: { scrollTop: number, scrollHeight: number, clientHeight: number }, threshold = 40): boolean {
  return s.scrollHeight - s.scrollTop - s.clientHeight <= threshold
}

/** Count of items after the one with id === lastSeenId (exclusive). 0 if not found / newest / null. Pure. */
export function countNewSince<T extends { id: string }>(items: T[], lastSeenId: string | null): number {
  if (!lastSeenId) return 0
  const i = items.findIndex(x => x.id === lastSeenId)
  return i < 0 ? 0 : items.length - 1 - i
}
