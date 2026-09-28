// app/lib/channels/status-dot.ts
// The Settings → Channels nav dot (cycle 75): green when the last BlueBubbles health check passed,
// amber when it passed with the Private API off (sends fall back to AppleScript — no typing,
// tapbacks or approvals), red when it failed. Neutral (grey) while iMessage is enabled but not
// checked yet (`checkedAt` null — after boot, or after a save that enabled it or changed the
// server; final review M6), so a fresh enable never flashes red. Hidden (null) while disabled.
export interface ChannelsHealth { enabled: boolean, ok: boolean, privateApi: boolean | null, checkedAt?: number | null }

export function channelsDotColor(h: ChannelsHealth | undefined): 'success' | 'warning' | 'error' | 'neutral' | null {
  if (!h?.enabled) return null
  if (h.checkedAt == null) return 'neutral'
  if (!h.ok) return 'error'
  return h.privateApi === false ? 'warning' : 'success'
}
