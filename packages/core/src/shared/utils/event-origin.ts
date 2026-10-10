/**
 * Splits an event row's `origin` ('<kind>:<detail>') on its FIRST colon only. The detail may
 * itself contain colons — a job wake is `wake:job:<slug>` — and `split(':', 2)` truncated it to
 * "job", so neither the divider ("woken · job") nor the model ("Background wake (job)") could
 * tell which job spoke (cycle 74 final review M1). Shared by the server's event-text and the
 * client's divider label so the two can never split differently.
 */
export function splitOrigin(origin: string | null | undefined): { kind: string, detail: string } {
  const o = origin ?? ''
  const i = o.indexOf(':')
  return i === -1 ? { kind: o, detail: '' } : { kind: o.slice(0, i), detail: o.slice(i + 1) }
}
