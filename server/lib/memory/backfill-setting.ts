// server/lib/memory/backfill-setting.ts
// Cycle 77: the settings-backed state machine for the dual-score backfill (spec D3, §2). One
// settings row, read fresh on every call. Mirrors server/lib/agent/self-improvement-mode.ts's
// tolerant pattern: a missing or malformed stored value falls back to the default rather than
// throwing.
import { eq } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { settings } from '@mymind/core/db/schema'

export const MEMORY_BACKFILL_KEY = 'memory_backfill'

export interface BackfillSetting {
  state: 'off' | 'running' | 'done'
  startedAt: string | null
  finishedAt: string | null
}

const STATES: readonly BackfillSetting['state'][] = ['off', 'running', 'done']
const DEFAULT_SETTING: BackfillSetting = { state: 'off', startedAt: null, finishedAt: null }

function parse(value: unknown): BackfillSetting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_SETTING }
  const v = value as Record<string, unknown>
  const state = typeof v.state === 'string' && (STATES as readonly string[]).includes(v.state)
    ? (v.state as BackfillSetting['state'])
    : 'off'
  return {
    state,
    startedAt: typeof v.startedAt === 'string' ? v.startedAt : null,
    finishedAt: typeof v.finishedAt === 'string' ? v.finishedAt : null
  }
}

/** Defaults to `{ state: 'off', startedAt: null, finishedAt: null }` on a missing or malformed
 *  stored value — never throws. */
export async function getBackfillSetting(): Promise<BackfillSetting> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, MEMORY_BACKFILL_KEY)).limit(1)
  return parse(row?.value)
}

/** Stamps `startedAt` on a transition to 'running' and `finishedAt` on a transition to 'done'
 *  (re-stamped on every call into that state, not only the first). The other timestamp carries
 *  over from the current stored value. */
export async function setBackfillState(state: BackfillSetting['state']): Promise<BackfillSetting> {
  const current = await getBackfillSetting()
  const now = new Date().toISOString()
  const next: BackfillSetting = {
    state,
    startedAt: state === 'running' ? now : current.startedAt,
    finishedAt: state === 'done' ? now : current.finishedAt
  }
  await useDb().insert(settings).values({ key: MEMORY_BACKFILL_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
  return next
}
