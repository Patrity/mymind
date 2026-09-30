// server/lib/agent/self-improvement-mode.ts
// Cycle 76: the self-improvement kill switch / gate mode (spec §2.5, §5.1). One settings row,
// read fresh on every call (the gate re-reads it before applying — spec's "mode switched to
// off mid-pass" row) rather than cached like persona.ts/skills-config.ts.
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'

export const SELF_IMPROVEMENT_MODE_KEY = 'self_improvement_mode'

export type SelfImprovementMode = 'on' | 'review_only' | 'off'
const MODES: readonly SelfImprovementMode[] = ['on', 'review_only', 'off']

/** Defaults to 'on'. Falls back to 'on' on a missing or malformed stored value — never throws. */
export async function getSelfImprovementMode(): Promise<SelfImprovementMode> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, SELF_IMPROVEMENT_MODE_KEY)).limit(1)
  const v = row?.value
  return typeof v === 'string' && (MODES as readonly string[]).includes(v) ? (v as SelfImprovementMode) : 'on'
}

export async function setSelfImprovementMode(mode: SelfImprovementMode): Promise<void> {
  await useDb().insert(settings).values({ key: SELF_IMPROVEMENT_MODE_KEY, value: mode, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: mode, updatedAt: new Date() } })
}
