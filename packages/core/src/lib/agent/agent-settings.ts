// Cycle 84 (spec §2.3): the agent settings doc — one settings row (`agent_settings`) holding
// Bridget's behaviour switches as JSON, starting with the judge / Smart Approvals fields under
// `judge`. Same shape as persona.ts / skills-config.ts: module-level cache, explicit invalidation
// (the web's PUT route refreshes its own copy and sends the worker an `invalidate` for
// 'agent-settings').
//
// Reading never throws and never trusts the stored JSON (fix round 1): a MISSING field reads as its
// default; a PRESENT but invalid one fails closed — a boolean reads as `false` (a corrupt row never
// switches auto-approval on) and a confidence reads as the strictest allowed threshold (0.99).
// Writing validates strictly.
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import { DEFAULT_JUDGE_SETTINGS, JUDGE_CONFIDENCE_LIMITS, type JudgeSettings } from './judge/types'

export const AGENT_SETTINGS_KEY = 'agent_settings'

export interface AgentSettings {
  judge: JudgeSettings
}

export function defaultAgentSettings(): AgentSettings {
  return {
    judge: {
      enabled: DEFAULT_JUDGE_SETTINGS.enabled,
      smartApprovals: { ...DEFAULT_JUDGE_SETTINGS.smartApprovals },
      confidence: DEFAULT_JUDGE_SETTINGS.confidence
    }
  }
}

const confidenceSchema = z.number().min(JUDGE_CONFIDENCE_LIMITS.min).max(JUDGE_CONFIDENCE_LIMITS.max)

/** A PUT body: any subset of the judge fields (merged onto the current settings), strictly typed. */
export const agentSettingsPatchSchema = z.object({
  judge: z.object({
    enabled: z.boolean().optional(),
    smartApprovals: z.object({
      workstreams: z.boolean().optional(),
      chat: z.boolean().optional()
    }).strict().optional(),
    confidence: confidenceSchema.optional()
  }).strict().optional()
}).strict()
export type AgentSettingsPatch = z.infer<typeof agentSettingsPatchSchema>

/** Missing → the default; present but not a boolean → false (fail closed). */
const bool = (v: unknown, d: boolean): boolean => (v === undefined ? d : v === true)

/** Pure: stored JSON → settings, field by field, defaults for anything missing or invalid. */
export function readAgentSettings(raw: unknown): AgentSettings {
  const d = defaultAgentSettings()
  const off: AgentSettings = { judge: { enabled: false, smartApprovals: { workstreams: false, chat: false }, confidence: JUDGE_CONFIDENCE_LIMITS.max } }
  if (raw === undefined || raw === null) return d // no row
  if (typeof raw !== 'object' || Array.isArray(raw)) return off // a corrupt row: everything off
  if (!('judge' in raw) || (raw as { judge?: unknown }).judge === undefined) return d
  const j = (raw as { judge?: unknown }).judge as Record<string, unknown>
  // A `judge` value that is not an object is corrupt: everything off.
  if (!j || typeof j !== 'object' || Array.isArray(j)) return off
  const saRaw = j.smartApprovals
  const saCorrupt = saRaw !== undefined && (saRaw === null || typeof saRaw !== 'object' || Array.isArray(saRaw))
  const sa = (saCorrupt ? { workstreams: false, chat: false } : (saRaw ?? {})) as Record<string, unknown>
  const conf = confidenceSchema.safeParse(j.confidence)
  return {
    judge: {
      enabled: bool(j.enabled, d.judge.enabled),
      smartApprovals: {
        workstreams: bool(sa?.workstreams, d.judge.smartApprovals.workstreams),
        chat: bool(sa?.chat, d.judge.smartApprovals.chat)
      },
      confidence: j.confidence === undefined ? d.judge.confidence : conf.success ? conf.data : JUDGE_CONFIDENCE_LIMITS.max
    }
  }
}

/** Pure: apply a validated patch. */
export function mergeAgentSettings(current: AgentSettings, patch: AgentSettingsPatch): AgentSettings {
  const j = patch.judge ?? {}
  return {
    judge: {
      enabled: j.enabled ?? current.judge.enabled,
      smartApprovals: {
        workstreams: j.smartApprovals?.workstreams ?? current.judge.smartApprovals.workstreams,
        chat: j.smartApprovals?.chat ?? current.judge.smartApprovals.chat
      },
      confidence: j.confidence ?? current.judge.confidence
    }
  }
}

let cache: AgentSettings | null = null

export async function getAgentSettings(): Promise<AgentSettings> {
  if (cache) return cache
  const [row] = await useDb().select().from(settings).where(eq(settings.key, AGENT_SETTINGS_KEY)).limit(1)
  cache = readAgentSettings(row?.value)
  return cache
}

/** The judge / Smart Approvals settings (Tasks 2 and 3 read these). */
export async function getJudgeSettings(): Promise<JudgeSettings> {
  return (await getAgentSettings()).judge
}

/** Fix round 1 (M1): the judge settings read from the DB now, bypassing the cache — the moment a
 *  Smart Approvals decision is made, so a switch turned off while a card was judged is honoured. */
export async function readJudgeSettingsFresh(): Promise<JudgeSettings> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, AGENT_SETTINGS_KEY)).limit(1)
  return readAgentSettings(row?.value).judge
}

/** Validate a patch (throws a ZodError on anything invalid), merge it onto the stored settings,
 *  save, and refresh this process's cache. Returns the saved settings. */
export async function saveAgentSettings(patch: unknown): Promise<AgentSettings> {
  const p = agentSettingsPatchSchema.parse(patch)
  cache = null
  const next = mergeAgentSettings(await getAgentSettings(), p)
  await useDb().insert(settings).values({ key: AGENT_SETTINGS_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
  cache = next
  return next
}

export function invalidateAgentSettings(): void { cache = null }
