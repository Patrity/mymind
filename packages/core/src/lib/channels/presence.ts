// server/lib/channels/presence.ts
// Is Tony at the web app right now? The client posts POST /api/presence on input/focus/visibility
// (throttled to once a minute); we keep the last ping in memory. After a restart he counts as away
// until the first ping — accepted in the spec (at most one extra iMessage).
import { loadChannelsConfig, type ChannelsDb } from './config'

let lastActiveAt: number | null = null

export function markActive(at: number = Date.now()): void {
  if (lastActiveAt === null || at > lastActiveAt) lastActiveAt = at
}

/** `db`: pass the open transaction when called inside one (see loadChannelsConfig). */
export async function isAway(now: number = Date.now(), db?: ChannelsDb): Promise<boolean> {
  if (lastActiveAt === null) return true
  const { presenceAwayMinutes } = await loadChannelsConfig(db)
  return now - lastActiveAt >= presenceAwayMinutes * 60_000
}

/** Test seam. */
export function _resetPresence(): void { lastActiveAt = null }

// ---- the run's presence in its iMessage chat (spec §4 step 5) ----
// A run answering an iMessage marks the chat read and shows typing while it works; typing goes
// off when the run ends. Needs the Private API, so skipped when the last health check said it's
// off (unknown still tries). Fire-and-forget: failures are logged, never thrown into the run.

interface PresenceClient { markRead(chatGuid: string): Promise<void>; typing(chatGuid: string, on: boolean): Promise<void> }
export interface ChannelPresenceDeps {
  client?: () => Promise<PresenceClient | null>
  health?: () => { privateApi: boolean | null }
}
type PresenceRun = { id: string; replyTo: unknown }

// Imported lazily: inbound.ts reaches the run queue, which imports the runner that calls this.
async function presenceClient(deps: ChannelPresenceDeps): Promise<PresenceClient | null> {
  const health = deps.health ?? (await import('./inbound')).lastHealth
  if (health().privateApi === false) return null
  return deps.client ? deps.client() : (await import('./bluebubbles/client')).imessageClient()
}

function replyChat(run: PresenceRun): string | null {
  const r = run.replyTo as { channel?: unknown; chatGuid?: unknown } | null
  return r?.channel === 'imessage' && typeof r.chatGuid === 'string' ? r.chatGuid : null
}

const starting = new Map<string, Promise<void>>()

export const channelPresence = {
  /** Mark the reply chat read and turn typing on. Never rejects. */
  start(run: PresenceRun, deps: ChannelPresenceDeps = {}): Promise<void> {
    const chat = replyChat(run)
    if (!chat) return Promise.resolve()
    const p = (async () => {
      const client = await presenceClient(deps)
      if (!client) return
      await client.markRead(chat).catch(err => console.error('[channels] markRead failed:', err))
      await client.typing(chat, true)
    })().catch(err => console.error('[channels] typing on failed:', err))
    starting.set(run.id, p)
    return p
  },

  /** Turn typing off — after a still-running start, so it can't be left on. Never rejects. */
  async stop(run: PresenceRun, deps: ChannelPresenceDeps = {}): Promise<void> {
    const chat = replyChat(run)
    if (!chat) return
    const pending = starting.get(run.id)
    starting.delete(run.id)
    await pending
    try {
      const client = await presenceClient(deps)
      if (client) await client.typing(chat, false)
    } catch (err) {
      console.error('[channels] typing off failed:', err)
    }
  }
}
