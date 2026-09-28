// app/lib/channels/status-dot.ts
// The Settings → Channels nav dot (cycle 75): green when the last BlueBubbles health check passed,
// amber when it passed with the Private API off (sends fall back to AppleScript — no typing,
// tapbacks or approvals), red when it failed. Hidden (null) while iMessage is disabled.
export interface ChannelsHealth { enabled: boolean, ok: boolean, privateApi: boolean | null }

export function channelsDotColor(h: ChannelsHealth | undefined): 'success' | 'warning' | 'error' | null {
  if (!h?.enabled) return null
  if (!h.ok) return 'error'
  return h.privateApi === false ? 'warning' : 'success'
}
