// Resolve every pending exec approval as DENIED and forget it. Used when the turn that asked
// is abandoned — a new turn, a Stop / barge-in (`interrupt`), or a new conversation — so a
// tool never waits out its 120 s timeout on a question nobody can see anymore.
export function denyPendingApprovals(pending: Map<string, { resolve: (d: { approved: boolean }) => void; timer: ReturnType<typeof setTimeout> }>): string[] {
  const ids = [...pending.keys()]
  for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ approved: false }) }
  pending.clear()
  return ids
}
