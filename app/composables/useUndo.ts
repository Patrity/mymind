// app/composables/useUndo.ts
import { undoFeedback } from '~/lib/agent/undo-feedback'

/** Redeem an undo token, surfacing a refusal instead of failing silently. */
export function useUndo() {
  const toast = useToast()
  return async function redeem(token: string): Promise<{ ok: boolean; reason?: string }> {
    const res = await $fetch<{ ok: boolean; reason?: string }>('/api/agent/undo', {
      method: 'POST', body: { token }
    })
    const feedback = undoFeedback(res)
    if (feedback) toast.add(feedback)
    return res
  }
}
