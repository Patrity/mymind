/**
 * Upward infinite scroll: when older rows are prepended, everything the reader was looking at
 * moves DOWN by exactly the height that appeared above it. Restoring scrollTop by that delta
 * keeps the same content under the cursor. Measuring the delta from scrollHeight (rather than
 * summing row heights) is what makes this correct with dynamically-measured rows.
 */
export function anchorAfterPrepend(m: {
  scrollTop: number
  prevScrollHeight: number
  nextScrollHeight: number
}): number {
  return Math.max(0, m.scrollTop + (m.nextScrollHeight - m.prevScrollHeight))
}
