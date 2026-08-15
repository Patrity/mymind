import type { UsageTokens, ModelRates } from '../../../shared/types/usage'

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Parse a `messages.usage` jsonb blob. Never throws — an unreadable blob is zero usage. */
export function parseUsage(raw: unknown): UsageTokens {
  const u = (raw ?? {}) as Record<string, unknown>
  const cc = (u.cache_creation ?? {}) as Record<string, unknown>
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreation: num(u.cache_creation_input_tokens),
    ephemeral5m: num(cc.ephemeral_5m_input_tokens),
    ephemeral1h: num(cc.ephemeral_1h_input_tokens)
  }
}

/**
 * API-equivalent value for one usage row. NOT money spent — Claude Code is subscription-billed.
 *
 * Five token classes, five rates. The residual term is load-bearing, not padding: 3 of the 81,954
 * usage-bearing rows in the real corpus report a non-zero `cache_creation_input_tokens` (3,028
 * each, 9,084 total) while both ephemeral tiers read 0, and dropping it would silently
 * under-report. It is priced at the cheaper 5m rate so an
 * unknown tier cannot inflate the figure, and clamped at 0 so an over-counted split cannot make
 * the total negative.
 */
export function computeValue(t: UsageTokens, r: ModelRates): number {
  const residual = Math.max(0, t.cacheCreation - (t.ephemeral5m + t.ephemeral1h))
  return t.input * r.input
    + t.output * r.output
    + t.cacheRead * r.cacheRead
    + t.ephemeral5m * r.cacheCreation
    + t.ephemeral1h * r.cacheCreationAbove1h
    + residual * r.cacheCreation
}
