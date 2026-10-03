/**
 * Pure job-file parser. Turns a job markdown document (frontmatter + body) into a validated
 * JobSpec, or a single human-readable error. No DB, no scheduling — see schedule.ts for that.
 */
import { Cron } from 'croner'
import { splitFrontmatter } from '../../../../shared/utils/frontmatter'
import { parseEveryExpr, resolveAtInstant, minCronGapMs } from './schedule'
import { ON_DEMAND_TOOLSETS, parseToolsetIds, type ToolsetId } from '../toolsets'

export type TriggerKind = 'cron' | 'every' | 'at' | 'event'

export interface JobSpec {
  trigger: { kind: TriggerKind; expr: string }
  timezone: string
  activeHours: { start: string; end: string } | null
  model: string
  thread: 'main' | 'isolated'
  context: 'light' | 'full'
  deliver: string[]
  enabled: boolean
  filter: Record<string, string> | null
  /** Cycle 78: on-demand toolsets this job needs loaded at run start (e.g. ['images']). */
  toolsets: ToolsetId[]
  body: string
}

export const JOB_BODY_MAX = 20_000
export const MIN_INTERVAL_MS = 5 * 60_000

const ACCEPTED_KEYS = new Set(['trigger', 'timezone', 'active_hours', 'model', 'thread', 'context', 'deliver', 'enabled', 'filter', 'toolsets'])
const KNOWN_EVENTS = ['cc.session_end', 'task.due']
export const DELIVER_VALUES = ['app', 'auto', 'imessage', 'email'] as const
const ACTIVE_HOURS_RE = /^\d{2}:\d{2}-\d{2}:\d{2}$/

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function parseEvery(expr: string): ParseResult<number> {
  const every = parseEveryExpr(expr)
  if (!every) return { ok: false, error: `invalid every expression: ${expr}` }
  if (every.ms < MIN_INTERVAL_MS) return { ok: false, error: 'trigger must fire at least 5 minutes apart' }
  return { ok: true, value: every.ms }
}

function parseTrigger(raw: string, timezone: string): ParseResult<{ kind: TriggerKind; expr: string }> {
  const m = /^(cron|every|at|event)\s+(.+)$/.exec(raw.trim())
  if (!m) return { ok: false, error: `unknown trigger: ${raw}` }
  const kind = m[1] as TriggerKind
  const expr = (m[2] ?? '').trim()

  if (kind === 'cron') {
    let cron: Cron
    try {
      cron = new Cron(expr, { timezone, paused: true })
    } catch {
      return { ok: false, error: `invalid cron: ${expr}` }
    }
    const minGap = minCronGapMs(cron, MIN_INTERVAL_MS)
    if (minGap !== null && minGap < MIN_INTERVAL_MS) {
      return { ok: false, error: 'trigger must fire at least 5 minutes apart' }
    }
    return { ok: true, value: { kind, expr } }
  }

  if (kind === 'every') {
    const every = parseEvery(expr)
    if (!every.ok) return every
    return { ok: true, value: { kind, expr } }
  }

  if (kind === 'at') {
    if (!resolveAtInstant(expr, timezone)) return { ok: false, error: `trigger 'at' requires a valid date: ${expr}` }
    return { ok: true, value: { kind, expr } }
  }

  // kind === 'event'
  if (!KNOWN_EVENTS.includes(expr)) return { ok: false, error: `unknown event: ${expr}` }
  return { ok: true, value: { kind, expr } }
}

export function parseJob(
  md: string,
  opts: { defaultTimezone: string; isKnownModel?: (id: string) => boolean }
): { ok: true; spec: JobSpec } | { ok: false; error: string } {
  const { data, body, error: splitError } = splitFrontmatter(md)
  if (splitError) return { ok: false, error: splitError }

  for (const key of Object.keys(data)) {
    if (!ACCEPTED_KEYS.has(key)) return { ok: false, error: `unknown key: ${key}` }
  }

  const timezoneRaw = data.timezone
  const timezone = typeof timezoneRaw === 'string' ? timezoneRaw : opts.defaultTimezone
  if (!isValidTimezone(timezone)) return { ok: false, error: `invalid timezone: ${timezone}` }

  const triggerRaw = data.trigger
  if (typeof triggerRaw !== 'string' || !triggerRaw.trim()) {
    return { ok: false, error: `unknown trigger: ${String(triggerRaw)}` }
  }
  const trigger = parseTrigger(triggerRaw, timezone)
  if (!trigger.ok) return trigger

  let activeHours: { start: string; end: string } | null = null
  if (data.active_hours !== undefined) {
    if (typeof data.active_hours !== 'string' || !ACTIVE_HOURS_RE.test(data.active_hours)) {
      return { ok: false, error: `invalid active_hours: ${String(data.active_hours)}` }
    }
    const [start, end] = data.active_hours.split('-')
    activeHours = { start: start ?? '', end: end ?? '' }
  }

  let thread: 'main' | 'isolated' = 'main'
  if (data.thread !== undefined) {
    if (data.thread !== 'main' && data.thread !== 'isolated') {
      return { ok: false, error: `invalid thread: ${String(data.thread)}` }
    }
    thread = data.thread
  }

  let context: 'light' | 'full' = 'full'
  if (data.context !== undefined) {
    if (data.context !== 'light' && data.context !== 'full') {
      return { ok: false, error: `invalid context: ${String(data.context)}` }
    }
    context = data.context
  }

  // Cycle 75 ruling 3: no `deliver:` key means `[auto]` (iMessage when Tony is away). Whether a
  // named channel is actually configured is a store.ts write-time check, not a parse error.
  let deliver: string[] = ['auto']
  if (data.deliver !== undefined) {
    if (!Array.isArray(data.deliver) || !data.deliver.every(d => typeof d === 'string')) {
      return { ok: false, error: `invalid deliver: ${String(data.deliver)} (allowed: ${DELIVER_VALUES.join(', ')})` }
    }
    if (!data.deliver.length) return { ok: false, error: `invalid deliver: empty list (allowed: ${DELIVER_VALUES.join(', ')})` }
    const unknown = data.deliver.find(d => !(DELIVER_VALUES as readonly string[]).includes(d))
    if (unknown !== undefined) return { ok: false, error: `invalid deliver: ${unknown} (allowed: ${DELIVER_VALUES.join(', ')})` }
    deliver = data.deliver
  }

  let enabled = false
  if (data.enabled !== undefined) {
    if (typeof data.enabled !== 'boolean') return { ok: false, error: `invalid enabled: ${String(data.enabled)}` }
    enabled = data.enabled
  }

  let filter: Record<string, string> | null = null
  if (data.filter !== undefined) {
    if (typeof data.filter !== 'object' || data.filter === null || Array.isArray(data.filter)) {
      return { ok: false, error: `invalid filter: ${String(data.filter)}` }
    }
    const coerced: Record<string, string> = {}
    for (const [key, value] of Object.entries(data.filter as Record<string, unknown>)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return { ok: false, error: `invalid filter value for ${key}: must be a string, number, or boolean` }
      }
      coerced[key] = String(value)
    }
    filter = coerced
  }

  let toolsets: ToolsetId[] = []
  if (data.toolsets !== undefined) {
    const allowed = ON_DEMAND_TOOLSETS.join(', ')
    if (!Array.isArray(data.toolsets) || !data.toolsets.every(x => typeof x === 'string')) return { ok: false, error: `invalid toolsets: ${String(data.toolsets)} (allowed: ${allowed})` }
    const bad = data.toolsets.find(x => !parseToolsetIds([x]).length)
    if (bad !== undefined) return { ok: false, error: `invalid toolsets: ${bad} (allowed: ${allowed})` }
    toolsets = parseToolsetIds(data.toolsets)
  }

  let model = 'default'
  if (data.model !== undefined) {
    if (typeof data.model !== 'string') return { ok: false, error: `invalid model: ${String(data.model)}` }
    model = data.model
    if (model !== 'default' && opts.isKnownModel && !opts.isKnownModel(model)) {
      return { ok: false, error: `unknown model: ${model}` }
    }
  }

  const trimmedBody = body.trim()
  if (!trimmedBody) return { ok: false, error: 'job body must not be empty' }
  if (trimmedBody.length > JOB_BODY_MAX) return { ok: false, error: `job body exceeds ${JOB_BODY_MAX} characters` }

  return {
    ok: true,
    spec: {
      trigger: trigger.value,
      timezone,
      activeHours,
      model,
      thread,
      context,
      deliver,
      enabled,
      filter,
      toolsets,
      body: trimmedBody
    }
  }
}
