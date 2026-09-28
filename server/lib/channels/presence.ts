// server/lib/channels/presence.ts
// Is Tony at the web app right now? The client posts POST /api/presence on input/focus/visibility
// (throttled to once a minute); we keep the last ping in memory. After a restart he counts as away
// until the first ping — accepted in the spec (at most one extra iMessage).
import { loadChannelsConfig } from './config'

let lastActiveAt: number | null = null

export function markActive(at: number = Date.now()): void {
  if (lastActiveAt === null || at > lastActiveAt) lastActiveAt = at
}

export async function isAway(now: number = Date.now()): Promise<boolean> {
  if (lastActiveAt === null) return true
  const { presenceAwayMinutes } = await loadChannelsConfig()
  return now - lastActiveAt >= presenceAwayMinutes * 60_000
}

/** Test seam. */
export function _resetPresence(): void { lastActiveAt = null }
