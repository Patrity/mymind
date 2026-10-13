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
import { DEFAULT_JUDGE_MAX_IN_FLIGHT, JUDGE_MAX_IN_FLIGHT_LIMITS, setJudgeMaxInFlight } from './judge/limiter'
import { currentEvalScope, processCache } from '../eval/context'

export const AGENT_SETTINGS_KEY = 'agent_settings'

export interface AgentSettings {
  judge: JudgeSettings
}

export function defaultAgentSettings(): AgentSettings {
  return {
    judge: {
      enabled: DEFAULT_JUDGE_SETTINGS.enabled,
      smartApprovals: { ...DEFAULT_JUDGE_SETTINGS.smartApprovals },
      confidence: DEFAULT_JUDGE_SETTINGS.confidence,
      maxInFlight: DEFAULT_JUDGE_MAX_IN_FLIGHT
    }
  }
}

const confidenceSchema = z.number().min(JUDGE_CONFIDENCE_LIMITS.min).max(JUDGE_CONFIDENCE_LIMITS.max)
const maxInFlightSchema = z.number().int().min(JUDGE_MAX_IN_FLIGHT_LIMITS.min).max(JUDGE_MAX_IN_FLIGHT_LIMITS.max)

/** A PUT body: any subset of the judge fields (merged onto the current settings), strictly typed. */
export const agentSettingsPatchSchema = z.object({
  judge: z.object({
    enabled: z.boolean().optional(),
    smartApprovals: z.object({
      workstreams: z.boolean().optional(),
      chat: z.boolean().optional()
    }).strict().optional(),
    confidence: confidenceSchema.optional(),
    maxInFlight: maxInFlightSchema.optional()
  }).strict().optional()
}).strict()
export type AgentSettingsPatch = z.infer<typeof agentSettingsPatchSchema>

/** Missing → the default; present but not a boolean → false (fail closed). */
const bool = (v: unknown, d: boolean): boolean => (v === undefined ? d : v === true)

/** Pure: stored JSON → settings, field by field, defaults for anything missing or invalid. */
export function readAgentSettings(raw: unknown): AgentSettings {
  const d = defaultAgentSettings()
  const off: AgentSettings = { judge: { enabled: false, smartApprovals: { workstreams: false, chat: false }, confidence: JUDGE_CONFIDENCE_LIMITS.max, maxInFlight: DEFAULT_JUDGE_MAX_IN_FLIGHT } }
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
      confidence: j.confidence === undefined ? d.judge.confidence : conf.success ? conf.data : JUDGE_CONFIDENCE_LIMITS.max,
      // A capacity knob, not a safety switch: an invalid value reads as the default.
      maxInFlight: maxInFlightSchema.safeParse(j.maxInFlight).success ? j.maxInFlight as number : DEFAULT_JUDGE_MAX_IN_FLIGHT
    }
  }
}

/**
 * Task 4 fix round 1 (M1): which stored fields readAgentSettings had to fail closed on — empty when the
 * row is missing or valid. The settings page shows this ("Smart Approvals is off") instead of letting
 * a corrupt row look like a deliberate "off".
 */
export function agentSettingsProblems(raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  if (typeof raw !== 'object' || Array.isArray(raw)) return ['the settings document']
  const j = (raw as { judge?: unknown }).judge
  if (j === undefined) return []
  if (!j || typeof j !== 'object' || Array.isArray(j)) return ['judge']
  const o = j as Record<string, unknown>
  const out: string[] = []
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') out.push('judge.enabled')
  const sa = o.smartApprovals
  if (sa !== undefined) {
    if (sa === null || typeof sa !== 'object' || Array.isArray(sa)) out.push('judge.smartApprovals')
    else {
      for (const k of ['workstreams', 'chat'] as const) {
        const v = (sa as Record<string, unknown>)[k]
        if (v !== undefined && typeof v !== 'boolean') out.push(`judge.smartApprovals.${k}`)
      }
    }
  }
  if (o.confidence !== undefined && !confidenceSchema.safeParse(o.confidence).success) out.push('judge.confidence')
  if (o.maxInFlight !== undefined && !maxInFlightSchema.safeParse(o.maxInFlight).success) out.push('judge.maxInFlight')
  return out
}

/** GET /api/settings/agent-settings: the settings as the worker reads them, plus any stored field it
 *  had to fail closed on (read fresh, so a repaired row shows at once). */
export async function readAgentSettingsWithProblems(): Promise<AgentSettings & { problems: string[] }> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, AGENT_SETTINGS_KEY)).limit(1)
  return { ...readAgentSettings(row?.value), problems: agentSettingsProblems(row?.value) }
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
      confidence: j.confidence ?? current.judge.confidence,
      maxInFlight: j.maxInFlight ?? current.judge.maxInFlight ?? DEFAULT_JUDGE_MAX_IN_FLIGHT
    }
  }
}

// Cycle 85: an eval world bypasses this process cache (lib/eval/context.ts processCache).
const cache = processCache<AgentSettings>()

export async function getAgentSettings(): Promise<AgentSettings> {
  const hit = cache.get()
  if (hit) return hit
  const [row] = await useDb().select().from(settings).where(eq(settings.key, AGENT_SETTINGS_KEY)).limit(1)
  const loaded = readAgentSettings(row?.value)
  if (!currentEvalScope()) setJudgeMaxInFlight(loaded.judge.maxInFlight)
  cache.set(loaded)
  return loaded
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
  cache.set(null)
  const next = mergeAgentSettings(await getAgentSettings(), p)
  await useDb().insert(settings).values({ key: AGENT_SETTINGS_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
  cache.set(next)
  if (!currentEvalScope()) setJudgeMaxInFlight(next.judge.maxInFlight)
  return next
}

export function invalidateAgentSettings(): void { cache.set(null) }
