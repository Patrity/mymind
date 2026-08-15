import { sql } from 'drizzle-orm'
import { useDb } from '../db'
import { computeValue } from '../lib/analytics/cost'
import { USAGE_RANGE_KEYS } from '../../shared/types/usage'
import type {
  UsageRangeKey, UsageResponse, DispatchResponse, ModelRates, ModelUsageRow, UsageTokens
} from '../../shared/types/usage'

const DAYS: Record<Exclude<UsageRangeKey, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 }

export function isUsageRange(v: string): v is UsageRangeKey {
  return (USAGE_RANGE_KEYS as readonly string[]).includes(v)
}

/** Lower bound for a range, truncated to UTC midnight. `all` means no bound. */
export function rangeStart(range: UsageRangeKey, now = new Date()): Date | null {
  if (range === 'all') return null
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - DAYS[range])
  return d
}

// The six token fields, matching the json paths `parseUsage` (server/lib/analytics/cost.ts) reads
// — but summed in SQL, not by calling that parser. Reused by two queries below: `perModel` groups
// by model only, and `computeValue` is applied once per model over that model's whole-range
// totals; `perDay` groups by (day, model) and returns raw token sums that are NEVER priced —
// `UsageDayPoint` has no value field — it only feeds the daily stacked chart's token counts.
const TOKEN_SUMS = sql`
  sum(coalesce((usage->>'input_tokens')::bigint, 0))                                   as input,
  sum(coalesce((usage->>'output_tokens')::bigint, 0))                                  as output,
  sum(coalesce((usage->>'cache_read_input_tokens')::bigint, 0))                        as cache_read,
  sum(coalesce((usage->>'cache_creation_input_tokens')::bigint, 0))                    as cache_creation,
  sum(coalesce((usage->'cache_creation'->>'ephemeral_5m_input_tokens')::bigint, 0))    as eph_5m,
  sum(coalesce((usage->'cache_creation'->>'ephemeral_1h_input_tokens')::bigint, 0))    as eph_1h`

const toTokens = (r: Record<string, unknown>): UsageTokens => ({
  input: Number(r.input ?? 0),
  output: Number(r.output ?? 0),
  cacheRead: Number(r.cache_read ?? 0),
  cacheCreation: Number(r.cache_creation ?? 0),
  ephemeral5m: Number(r.eph_5m ?? 0),
  ephemeral1h: Number(r.eph_1h ?? 0)
})

const totalOf = (t: UsageTokens) => t.input + t.output + t.cacheRead + t.cacheCreation

export async function getUsage(range: UsageRangeKey): Promise<UsageResponse> {
  const db = useDb()
  const start = rangeStart(range)
  // Bound parameter, never interpolated — and `range` is already validated at the endpoint.
  const since = start ? sql`and created_at >= ${start.toISOString()}` : sql``

  // Rates first: a model absent here is UNPRICED, never zero-valued.
  const priceRows = await db.execute(sql`select * from model_prices`)
  const rates = new Map<string, ModelRates>()
  for (const p of priceRows.rows as Record<string, unknown>[]) {
    rates.set(String(p.model), {
      input: Number(p.input_cost_per_token),
      output: Number(p.output_cost_per_token),
      cacheRead: Number(p.cache_read_cost_per_token),
      cacheCreation: Number(p.cache_creation_cost_per_token),
      cacheCreationAbove1h: Number(p.cache_creation_above_1h_cost_per_token)
    })
  }

  // Sidechain rows are INCLUDED on purpose — subagent usage is real usage.
  const perModel = await db.execute(sql`
    select model, ${TOKEN_SUMS}
    from messages
    where usage is not null and model is not null ${since}
    group by model`)

  // `created_at` is `timestamptz`; `date_trunc('day', ...)` on it uses the DATABASE SESSION's
  // TimeZone setting, not UTC. `rangeStart()` above and `litellm_daily.day` are hard UTC, so an
  // unpinned bucket here is an implicit dependency on the session TimeZone being UTC — true today
  // (`Etc/UTC`), but a session with a different TimeZone set would bucket days differently and
  // silently disagree with the rest of this response. Pin it explicitly.
  const perDay = await db.execute(sql`
    select to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') as day, model, ${TOKEN_SUMS}
    from messages
    where usage is not null and model is not null ${since}
    group by 1, 2 order by 1`)

  const byModel: ModelUsageRow[] = []
  const unpricedModels: string[] = []
  let unpricedTokens = 0, totalTokens = 0, totalCacheRead = 0, totalValue = 0

  for (const row of perModel.rows as Record<string, unknown>[]) {
    const model = String(row.model)
    const tokens = toTokens(row)
    const r = rates.get(model)
    const valueUsd = r ? computeValue(tokens, r) : null
    totalTokens += totalOf(tokens)
    totalCacheRead += tokens.cacheRead
    if (valueUsd === null) { unpricedModels.push(model); unpricedTokens += totalOf(tokens) }
    else totalValue += valueUsd
    byModel.push({ model, tokens, valueUsd })
  }
  byModel.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))

  const dailyMap = new Map<string, Record<string, number>>()
  for (const row of perDay.rows as Record<string, unknown>[]) {
    const day = String(row.day)
    if (!dailyMap.has(day)) dailyMap.set(day, {})
    dailyMap.get(day)![String(row.model)] = totalOf(toTokens(row))
  }

  const [{ rows: [sessRow] }, { rows: [dispRow] }, litellmRes] = await Promise.all([
    db.execute(sql`select count(distinct session_id)::int as n from messages where usage is not null ${since}`),
    db.execute(sql`select count(*)::int as n from tool_events where tool_name = 'Agent' ${since}`),
    db.execute(sql`select to_char(day,'YYYY-MM-DD') as day, sum(spend)::float8 as spend, sum(tokens)::bigint as tokens
                   from litellm_daily ${start ? sql`where day >= ${start.toISOString().slice(0, 10)}` : sql``}
                   group by 1 order by 1`)
  ])

  return {
    range,
    totals: {
      tokens: totalTokens,
      cacheReadPct: totalTokens > 0 ? (totalCacheRead / totalTokens) * 100 : 0,
      valueUsd: totalValue,
      sessions: Number((sessRow as Record<string, unknown>)?.n ?? 0),
      dispatches: Number((dispRow as Record<string, unknown>)?.n ?? 0)
    },
    byModel,
    daily: [...dailyMap.entries()].map(([day, byModel]) => ({ day, byModel })),
    unpriced: { models: unpricedModels, tokens: unpricedTokens },
    litellm: (litellmRes.rows as Record<string, unknown>[]).map(r => ({
      day: String(r.day), spendUsd: Number(r.spend ?? 0), tokens: Number(r.tokens ?? 0)
    }))
  }
}

export async function getDispatches(range: UsageRangeKey): Promise<DispatchResponse> {
  const db = useDb()
  const start = rangeStart(range)
  const since = start ? sql`and created_at >= ${start.toISOString()}` : sql``
  const res = await db.execute(sql`
    select coalesce(nullif(args->>'subagent_type', ''), '(unspecified)') as subagent_type,
           count(*)::int as n
    from tool_events
    where tool_name = 'Agent' ${since}
    group by 1 order by 2 desc`)
  return {
    range,
    bySubagent: (res.rows as Record<string, unknown>[])
      .map(r => ({ subagentType: String(r.subagent_type), count: Number(r.n) }))
  }
}
