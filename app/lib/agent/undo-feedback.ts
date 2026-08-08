// app/lib/agent/undo-feedback.ts
//
// Undo can REFUSE: the server declines rather than clobbering a write that landed after the
// action. A refusal that shows nothing is indistinguishable from a broken button, so every
// caller renders the same thing. Pure so it is testable without a Nuxt runtime.
export function undoFeedback(
  res: { ok: boolean; reason?: string }
): { title: string; description: string; color: 'error' } | null {
  if (res.ok) return null
  return {
    title: 'Nothing was undone',
    description: res.reason ?? 'the undo is no longer available',
    color: 'error'
  }
}
