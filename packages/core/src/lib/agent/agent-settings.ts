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
//
// Cycle 85 final fix wave: `judge.maxInFlight` is per class `{ guard, approval, outcome }` (I1; a stored
// bare number is the guard cap), and an `eval` section holds the eval runner's capacity knobs —
// `concurrency` (attempts at once, 1–4; default 1 in production, 2 elsewhere — I2/I3) and
// `maxTokensPerRun` (a run past it stops, `stopped: budget` — I4).
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import { DEFAULT_JUDGE_SETTINGS, JUDGE_CONFIDENCE_LIMITS, type JudgeSettings } from './judge/types'
import { DEFAULT_JUDGE_MAX_IN_FLIGHT, JUDGE_CLASSES, JUDGE_MAX_IN_FLIGHT_LIMITS, normalizeJudgeMaxInFlight, setJudgeMaxInFlight } from './judge/limiter'
import { currentEvalScope, processCache } from '../eval/context'

export const AGENT_SETTINGS_KEY = 'agent_settings'

/** Cycle 85 final fix wave: the eval runner's capacity knobs. */
export interface EvalSettings {
  /** Attempts of one eval run in parallel (1–4). */
  concurrency: number
  /** A run whose attempts have used more tokens than this stops (`stopped: budget`). */
  maxTokensPerRun: number
}

export const EVAL_CONCURRENCY_LIMITS = { min: 1, max: 4 } as const
export const EVAL_MAX_TOKENS_LIMITS = { min: 10_000, max: 1_000_000_000 } as const
export const DEFAULT_EVAL_MAX_TOKENS_PER_RUN = 5_000_000
/** Prod (one box, Tony's live work on the same models) runs one attempt at a time; dev two. */
export function defaultEvalConcurrency(): number {
  return process.env.NODE_ENV === 'production' ? 1 : 2
}

export interface AgentSettings {
  judge: JudgeSettings
  eval: EvalSettings
}

function defaultEvalSettings(): EvalSettings {
  return { concurrency: defaultEvalConcurrency(), maxTokensPerRun: DEFAULT_EVAL_MAX_TOKENS_PER_RUN }
}

export function defaultAgentSettings(): AgentSettings {
  return {
    judge: {
      enabled: DEFAULT_JUDGE_SETTINGS.enabled,
      smartApprovals: { ...DEFAULT_JUDGE_SETTINGS.smartApprovals },
      confidence: DEFAULT_JUDGE_SETTINGS.confidence,
      maxInFlight: { ...DEFAULT_JUDGE_MAX_IN_FLIGHT }
    },
    eval: defaultEvalSettings()
  }
}

const confidenceSchema = z.number().min(JUDGE_CONFIDENCE_LIMITS.min).max(JUDGE_CONFIDENCE_LIMITS.max)
const capSchema = z.number().int().min(JUDGE_MAX_IN_FLIGHT_LIMITS.min).max(JUDGE_MAX_IN_FLIGHT_LIMITS.max)
/** A patch: a bare number (the guard cap — cycle 84's shape) or any subset of the three classes. */
const maxInFlightSchema = z.union([
  capSchema,
  z.object({ guard: capSchema.optional(), approval: capSchema.optional(), outcome: capSchema.optional() }).strict()
])
const evalConcurrencySchema = z.number().int().min(EVAL_CONCURRENCY_LIMITS.min).max(EVAL_CONCURRENCY_LIMITS.max)
const evalMaxTokensSchema = z.number().int().min(EVAL_MAX_TOKENS_LIMITS.min).max(EVAL_MAX_TOKENS_LIMITS.max)

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
  }).strict().optional(),
  eval: z.object({
    concurrency: evalConcurrencySchema.optional(),
    maxTokensPerRun: evalMaxTokensSchema.optional()
  }).strict().optional()
}).strict()
export type AgentSettingsPatch = z.infer<typeof agentSettingsPatchSchema>

/** Missing → the default; present but not a boolean → false (fail closed). */
const bool = (v: unknown, d: boolean): boolean => (v === undefined ? d : v === true)

/** Pure: the stored `eval` section → its knobs; a missing or invalid field reads as its default (capacity
 *  knobs, not safety switches). */
function readEvalSettings(raw: unknown): EvalSettings {
  const d = defaultEvalSettings()
  const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  return {
    concurrency: evalConcurrencySchema.safeParse(e.concurrency).success ? e.concurrency as number : d.concurrency,
    maxTokensPerRun: evalMaxTokensSchema.safeParse(e.maxTokensPerRun).success ? e.maxTokensPerRun as number : d.maxTokensPerRun
  }
}

/** Pure: stored JSON → settings, field by field, defaults for anything missing or invalid. */
export function readAgentSettings(raw: unknown): AgentSettings {
  const d = defaultAgentSettings()
  const off: AgentSettings = { judge: { enabled: false, smartApprovals: { workstreams: false, chat: false }, confidence: JUDGE_CONFIDENCE_LIMITS.max, maxInFlight: { ...DEFAULT_JUDGE_MAX_IN_FLIGHT } }, eval: defaultEvalSettings() }
  if (raw === undefined || raw === null) return d // no row
  if (typeof raw !== 'object' || Array.isArray(raw)) return off // a corrupt row: everything off
  const ev = readEvalSettings((raw as { eval?: unknown }).eval)
  if (!('judge' in raw) || (raw as { judge?: unknown }).judge === undefined) return { ...d, eval: ev }
  const j = (raw as { judge?: unknown }).judge as Record<string, unknown>
  // A `judge` value that is not an object is corrupt: everything off.
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ...off, eval: ev }
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
      // A capacity knob, not a safety switch: an invalid value reads as the default (per class).
      maxInFlight: normalizeJudgeMaxInFlight(j.maxInFlight)
    },
    eval: ev
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
  const out: string[] = []
  const e = (raw as { eval?: unknown }).eval
  if (e !== undefined) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) out.push('eval')
    else {
      const x = e as Record<string, unknown>
      if (x.concurrency !== undefined && !evalConcurrencySchema.safeParse(x.concurrency).success) out.push('eval.concurrency')
      if (x.maxTokensPerRun !== undefined && !evalMaxTokensSchema.safeParse(x.maxTokensPerRun).success) out.push('eval.maxTokensPerRun')
    }
  }
  const j = (raw as { judge?: unknown }).judge
  if (j === undefined) return out
  if (!j || typeof j !== 'object' || Array.isArray(j)) return ['judge', ...out]
  const o = j as Record<string, unknown>
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
  if (o.maxInFlight !== undefined) {
    const m = o.maxInFlight
    if (typeof m === 'number' || !m || typeof m !== 'object' || Array.isArray(m)) {
      if (!capSchema.safeParse(m).success) out.push('judge.maxInFlight')
    } else {
      for (const k of JUDGE_CLASSES) {
        const v = (m as Record<string, unknown>)[k]
        if (v !== undefined && !capSchema.safeParse(v).success) out.push(`judge.maxInFlight.${k}`)
      }
    }
  }
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
  const cur = normalizeJudgeMaxInFlight(current.judge.maxInFlight)
  const m = j.maxInFlight
  const maxInFlight = m === undefined ? cur : typeof m === 'number' ? { ...cur, guard: m } : { ...cur, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) }
  return {
    judge: {
      enabled: j.enabled ?? current.judge.enabled,
      smartApprovals: {
        workstreams: j.smartApprovals?.workstreams ?? current.judge.smartApprovals.workstreams,
        chat: j.smartApprovals?.chat ?? current.judge.smartApprovals.chat
      },
      confidence: j.confidence ?? current.judge.confidence,
      maxInFlight
    },
    eval: {
      concurrency: patch.eval?.concurrency ?? current.eval.concurrency,
      maxTokensPerRun: patch.eval?.maxTokensPerRun ?? current.eval.maxTokensPerRun
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

/** Cycle 85 final fix wave: the eval runner's knobs, read fresh (a run start is rare; another process
 *  may have changed them). */
export async function readEvalSettingsFresh(): Promise<EvalSettings> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, AGENT_SETTINGS_KEY)).limit(1)
  return readAgentSettings(row?.value).eval
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
