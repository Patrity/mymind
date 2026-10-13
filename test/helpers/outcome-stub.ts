// Cycle 85: every finish_workstream now runs the outcome verifier (judge/outcome.ts). Tests that
// finish workstreams for other reasons install this stub — a `met` verdict, no evidence gathering —
// so they never reach a real model or a real sandbox. The outcome judge's own tests override it.
import { outcomeDeps, type OutcomeVerdict } from '@mymind/core/lib/agent/judge/outcome'

export const MET: OutcomeVerdict = { verdict: 'met', confidence: 1, gaps: [], nextStep: null, model: 'stub', latencyMs: 0 }

export function stubOutcomeVerifier(): void {
  outcomeDeps.verify = async () => MET
  outcomeDeps.evidence = async (ws, summary) => ({ goal: ws.goal, summary, calls: [], totalCalls: 0, workspace: null })
  outcomeDeps.enabled = async () => true
}
