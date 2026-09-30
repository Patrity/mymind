// server/lib/agent/tools/reviews.ts
// Bridget's /review tools (cycle 76, spec §7a).
//
// - list_reviews: read-only, so it lives in agentTools (every run, and the MCP server, see it).
// - decide_review: DANGEROUS and PROFILE-ONLY (server/lib/agent/profile.ts). Being dangerous means
//   every call pauses for Tony's confirmation (buildAiTools → requestApproval: the inline card in
//   the app, a 👍 over iMessage), a channel with no approval UI auto-denies, a headless run never
//   gets it (classifyForHeadless → 'exclude': approving a proposal via a proposal is circular), and
//   the MCP server never registers it (it is not in agentTools, and MCP skips dangerous tools).
//
// Both follow the never-throw contract of the other cycle-74+ tools: failures come back as results.
import { z } from 'zod'
import type { AgentTool } from '../types'
import { runUndo } from '../undo'
import type { DecisionResult } from '../../../services/review-decisions'

// Loaded on first call, not at module load: review-decisions → api/review/kinds → runtime/replay
// imports agentTools (tools.ts), which spreads THIS module's listReviewsTool — a static import
// here closes that cycle and leaves listReviewsTool undefined inside agentTools.
const decisions = () => import('../../../services/review-decisions')

/** id → summary, filled by list_reviews so decide_review's (synchronous) approval text can name
 *  the item. Bounded: the oldest entries are evicted first. */
const summaryCache = new Map<string, string>()
const SUMMARY_CACHE_MAX = 500

function remember(id: string, summary: string) {
  summaryCache.delete(id)
  summaryCache.set(id, summary)
  while (summaryCache.size > SUMMARY_CACHE_MAX) summaryCache.delete(summaryCache.keys().next().value!)
}

export const listReviewsTool: AgentTool = {
  name: 'list_reviews',
  description: "List Tony's pending /review items, newest decisions first (conflicts, triage, proposed actions, self-improvements), then unreviewed memories. Each item has an id, kind, a one-line summary, a kind-specific detail, and `choices`: the exact outcomes that item supports (id, label, description). Pass `kind` to narrow to one kind.",
  kind: 'read',
  schema: {
    kind: z.string().min(1).max(60).optional().describe('Only items of this kind, e.g. "self-improvement", "memory-supersede", "memory-unreviewed"'),
    limit: z.number().int().min(1).max(50).default(20).describe('How many items to return (1–50, default 20)')
  },
  handler: async (a) => {
    try {
      const items = await (await decisions()).listPendingReviews({ kind: a.kind as string | undefined, limit: (a.limit as number | undefined) ?? 20 })
      for (const i of items) remember(i.id, i.summary)
      return { result: { items }, summary: `listed ${items.length} review item(s)` }
    } catch (err) {
      return { result: { ok: false, error: (err as Error).message }, summary: 'list_reviews failed' }
    }
  }
}

export const decideReviewTool: AgentTool = {
  name: 'decide_review',
  description: "Decide one pending /review item for Tony. `choice` must be one of that item's `choices` ids from list_reviews (e.g. approve / reject, or keep-both / archive-old / archive-new / archive-both for a memory conflict). Tony confirms every call before it runs. Returns ok:true with a summary, or ok:false with a reason (not_pending, unknown_kind, invalid_choice, conflict, apply_failed) and a plain explanation — relay it rather than retrying blindly.",
  kind: 'destructive',
  dangerous: true,
  schema: {
    id: z.union([z.uuid(), z.string().min(1).max(100)]).describe('The review item id from list_reviews'),
    choice: z.string().min(1).max(40).describe("One of the item's choice ids"),
    note: z.string().max(500).optional().describe('Why — kept with the tool call for the record')
  },
  describeApproval: (a) => {
    const id = String(a.id)
    const choice = String(a.choice)
    // Not allowlistable (no `allowlistable` flag): no saved pattern can approve it and the card
    // offers no "always allow" — every decision is confirmed.
    return { tool: 'decide_review', command: `${choice} — ${summaryCache.get(id) ?? id}`, proposedPattern: '' }
  },
  handler: async (a) => {
    const choice = String(a.choice)
    let r: DecisionResult
    try {
      r = await (await decisions()).decideReview(String(a.id), choice)
    } catch (err) {
      const message = `Could not decide: ${(err as Error).message}`
      return { result: { ok: false, reason: 'error', message }, summary: 'decide_review failed' }
    }
    if (!r.ok) return { result: { ok: false, reason: r.reason, message: r.message }, summary: `decide_review: ${r.reason}` }
    summaryCache.delete(String(a.id))
    const token = r.undoToken
    return {
      result: { ok: true, summary: r.summary, applied: r.applied },
      summary: `${choice}: ${r.summary}`,
      undo: token ? () => runUndo(token) : undefined
    }
  }
}
