// app/lib/agent/confinement.ts
// Cycle 86 (spec D6): a workspace tool call that ran under sandbox-exec carries `confined: {reason,
// note}` in its result (tools/workspace.ts withTaint). The tool part shows it as a chip, so the cost
// of the taint-confinement trial is visible where it happened. Pure (unit-tested).

export type ConfinementReason = 'tainted-run' | 'tainted-workspace' | 'unverified' | 'eval'

const LABELS: Record<ConfinementReason, string> = {
  'tainted-run': 'confined (tainted run)',
  'tainted-workspace': 'confined (tainted workspace)',
  unverified: 'confined (unverified content)',
  eval: 'confined (eval)'
}

export interface ConfinementView { reason: ConfinementReason; label: string; note: string }

/** The chip for a tool result, or null. Only the four known reasons count; the note is our own text
 *  (the tools write it), shown as plain text. */
export function confinementOf(value: unknown): ConfinementView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const c = (value as { confined?: unknown }).confined
  if (!c || typeof c !== 'object') return null
  const reason = (c as { reason?: unknown }).reason
  if (typeof reason !== 'string' || !(reason in LABELS)) return null
  const note = (c as { note?: unknown }).note
  return { reason: reason as ConfinementReason, label: LABELS[reason as ConfinementReason], note: typeof note === 'string' ? note : '' }
}
