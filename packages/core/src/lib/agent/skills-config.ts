// server/lib/agent/skills-config.ts
// The agent-skills kill-switch. Same shape as persona.ts: one settings row,
// module-level cache, explicit invalidation. Default ON.
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import { processCache } from '../eval/context'

export const SKILLS_ENABLED_KEY = 'agent_skills_enabled'
const cache = processCache<boolean>() // cycle 85: bypassed in an eval world

export async function skillsEnabled(): Promise<boolean> {
  const hit = cache.get()
  if (hit !== null) return hit
  const [row] = await useDb().select().from(settings).where(eq(settings.key, SKILLS_ENABLED_KEY)).limit(1)
  const v = row?.value as { enabled?: unknown } | undefined
  const loaded = typeof v?.enabled === 'boolean' ? v.enabled : true
  cache.set(loaded)
  return loaded
}

export async function setSkillsEnabled(enabled: boolean): Promise<void> {
  await useDb().insert(settings).values({ key: SKILLS_ENABLED_KEY, value: { enabled }, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: { enabled }, updatedAt: new Date() } })
  cache.set(enabled)
}

export function invalidateSkillsEnabled(): void { cache.set(null) }
