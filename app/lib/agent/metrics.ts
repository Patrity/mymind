import type { MessageUsage } from '~~/shared/types/conversation'

/**
 * Output tokens per second over the GENERATING window — duration minus the wait for the
 * first token, so a slow model start does not read as slow generation.
 *
 * Known inaccuracy, stated rather than hidden: a turn that calls tools spends much of its
 * wall-clock waiting on them, and that time is still inside this window, so such a turn reads
 * slower than the model actually generated. `durationLabel` is displayed beside this so a low
 * figure is attributable. Measuring only the streaming intervals would be more accurate and
 * more machinery than a monitoring readout justifies.
 */
export function rateLabel(usage?: MessageUsage | null): string {
  const out = usage?.outputTokens
  const total = usage?.durationMs
  if (typeof out !== 'number' || out <= 0) return ''
  if (typeof total !== 'number' || total <= 0) return ''
  const windowMs = total - (usage?.ttftMs ?? 0)
  if (windowMs <= 0) return ''
  return `${(out / (windowMs / 1000)).toFixed(1)} tok/s`
}

/** "4.2s" / "820ms" — '' when no duration was recorded. */
export function durationLabel(usage?: MessageUsage | null): string {
  const ms = usage?.durationMs
  if (typeof ms !== 'number' || ms <= 0) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}
