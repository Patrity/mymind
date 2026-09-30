import { useDebounceFn } from '@vueuse/core'
import type { QueryClient } from '@tanstack/vue-query'
import type { LiveEvent, ResourceName } from '../../shared/types/live'

// Minimal surface we use — keeps the function unit-testable with a fake client.
type Invalidator = Pick<QueryClient, 'invalidateQueries'>

// A burst of graph-invalidating events (e.g. the enrich-memories cron firing many
// memory events within a few seconds) would otherwise refetch the whole ~1,900-node
// galaxy graph + rebuild all GPU buffers once per event. Trailing-debounce so a burst
// collapses into ONE ['graph'] refetch. The home dashboard below is debounced for the
// same reason; every other resource's invalidateQueries call stays immediate.
export const GRAPH_DEBOUNCE_MS = 700

// Home (cycle 56) is a cross-type view keyed on ['home'] and fed by nine resources.
// A Claude Code session streaming in produces the same burst shape the graph sees, so
// it gets the same treatment and the same figure — there is no reason for two.
export const HOME_DEBOUNCE_MS = 700

// The galaxy is a cross-type view keyed on ['graph'] alone (no id/list split), so
// any resource that can move a node or edge in it needs to invalidate that key too.
const debouncedInvalidateGraph = useDebounceFn(
  (c: Invalidator) => c.invalidateQueries({ queryKey: ['graph'] }),
  GRAPH_DEBOUNCE_MS
)
const invalidateGraph = (c: Invalidator) => { void debouncedInvalidateGraph(c) }

const debouncedInvalidateHome = useDebounceFn(
  (c: Invalidator) => c.invalidateQueries({ queryKey: ['home'] }),
  HOME_DEBOUNCE_MS
)
const invalidateHome = (c: Invalidator) => { void debouncedInvalidateHome(c) }

// Unreviewed memories are folded into the single `/review` feed (task-13) — a memory
// update can change the review badge/list too. `memory` events fire from several sites
// (memory-resolve.ts, triage.ts) including the enrich-memories cron's resolve path, which
// emits several per tick — the same burst shape ['graph']/['home'] above exist to absorb.
// Debounced for the same reason: ['review','count'] is always mounted (the sidebar badge),
// so without this a burst re-runs countReviewPending()'s two COUNT queries once per event
// instead of once per burst.
export const REVIEW_DEBOUNCE_MS = 700
const debouncedInvalidateReview = useDebounceFn(
  (c: Invalidator) => {
    c.invalidateQueries({ queryKey: ['review', 'count'] })
    c.invalidateQueries({ queryKey: ['review', 'list'] })
  },
  REVIEW_DEBOUNCE_MS
)
const invalidateReview = (c: Invalidator) => { void debouncedInvalidateReview(c) }

// Per-resource override hook. Default behaviour (invalidate detail + list) covers
// every resource today; add an entry here only when a resource needs extra keys.
const OVERRIDES: Partial<Record<ResourceName, (c: Invalidator, e: LiveEvent) => void>> = {
  memory: (c) => { c.invalidateQueries({ queryKey: ['memory', 'count'] }); invalidateReview(c); invalidateGraph(c); invalidateHome(c) },
  // A real review_queue decision (approve/reject/triage) is a single user-driven action,
  // not cron-bursty — keep this one immediate so the badge updates the instant the actor
  // who just clicked sees feedback.
  review: (c) => { c.invalidateQueries({ queryKey: ['review', 'count'] }); invalidateHome(c) },
  activity: (c) => { c.invalidateQueries({ queryKey: ['activity', 'count'] }); invalidateHome(c) },
  // Prompt macros (server/services/prompt-commands.ts) still publish `document`, so the `/`
  // command menu (useCommands, ['agent','commands']) keeps riding this signal.
  document: (c) => { c.invalidateQueries({ queryKey: ['agent', 'commands'] }); invalidateGraph(c); invalidateHome(c) },
  // Skills moved out of documents into agent_skills (cycle 74) with their own resource. A skill
  // write — human or a background agent — refreshes the skills list and the `/` menu, where
  // active skills are the other command source.
  agentSkill: (c) => { c.invalidateQueries({ queryKey: ['skills'] }); c.invalidateQueries({ queryKey: ['agent', 'commands'] }) },
  // Jobs (cycle 74): the /jobs list, each job's source/status/runs and its revisions all sit
  // under ['jobs']. A job's run finishing publishes agentJob too (outcome.ts), so the runs list
  // and last-outcome badge refresh without a separate agentRun hook.
  agentJob: (c) => { c.invalidateQueries({ queryKey: ['jobs'] }) },
  // Cycle 76 (Task 2): the "About Tony" profile — a singleton config, same shape as a skill/job
  // (server/services/profile.ts), read under ['profile', ...] (app/lib/config/source.ts's
  // queryBase for kind 'profile') rather than the default ['agentProfile', ...].
  agentProfile: (c) => { c.invalidateQueries({ queryKey: ['profile'] }) },
  // A folder mutation rewrites document paths, and the tree the user is looking at is keyed
  // ['document','list'] — invalidating only ['folder',*] (the default below) would leave the
  // tree stale, which is the whole point of wiring folders into live reactivity.
  folder: (c) => { c.invalidateQueries({ queryKey: ['document', 'list'] }); invalidateGraph(c); invalidateHome(c) },
  image: (c) => { invalidateGraph(c); invalidateHome(c) },
  session: (c) => { invalidateGraph(c); invalidateHome(c) },
  project: (c) => { invalidateGraph(c); invalidateHome(c) },
  task: (c) => invalidateHome(c),
  clipboard: (c) => invalidateHome(c),
  graph: (c) => invalidateGraph(c),
  // The Runs drawer keys its query ['agentRun', conversationId] — a per-thread list, not the
  // default [resource, 'list']. The event's own `id` is the RUN's id, not a conversation id,
  // so neither of the default invalidations above ever matches. Invalidating the bare
  // ['agentRun'] prefix catches every conversationId variant of that key at once (tanstack's
  // fuzzy queryKey matching: a query key starting with ['agentRun'] matches).
  agentRun: (c) => c.invalidateQueries({ queryKey: ['agentRun'] }),
  // Cycle 75: a channel delivery (iMessage/email send) is shown inline in the conversation
  // it replied to — invalidate the ['conversation'] prefix so any open thread view refreshes.
  channelDelivery: (c) => c.invalidateQueries({ queryKey: ['conversation'] })
}

export function dispatchLiveEvent(client: Invalidator, e: LiveEvent): void {
  client.invalidateQueries({ queryKey: [e.resource, e.id] })
  client.invalidateQueries({ queryKey: [e.resource, 'list'] })
  OVERRIDES[e.resource]?.(client, e)
}
