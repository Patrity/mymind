// PURE. No I/O, no db, no services — all triage policy lives here so it can be
// tested without a model or a database.
import type { TriageAction, TriageKind, TriageProposal } from '../../../shared/types/triage'

export type TriageThresholds = Record<TriageKind, number>

export interface RoutedAction {
  action: TriageAction
  autoApply: boolean
}

/**
 * Decide, per action, whether it applies now or waits for review.
 * Confidence alone decides. No destination categorically requires approval —
 * destinations differ only in where their bar sits.
 */
export function route(proposal: TriageProposal, thresholds: TriageThresholds): RoutedAction[] {
  const decide = (action: TriageAction): RoutedAction => ({
    action,
    // >= so a bar is a floor: an action exactly at 0.7 applies against a 0.7 bar.
    autoApply: action.confidence >= thresholds[action.kind]
  })
  return [proposal.primary, ...proposal.secondary].map(decide)
}
