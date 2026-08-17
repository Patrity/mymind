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
  // A skill is a document (type='skill') — a background agent write needs the
  // /settings/skills list to refresh too, not just the document graph/detail.
  document: (c) => { c.invalidateQueries({ queryKey: ['skills'] }); invalidateGraph(c); invalidateHome(c) },
  image: (c) => { invalidateGraph(c); invalidateHome(c) },
  session: (c) => { invalidateGraph(c); invalidateHome(c) },
  project: (c) => { invalidateGraph(c); invalidateHome(c) },
  task: (c) => invalidateHome(c),
  clipboard: (c) => invalidateHome(c),
  graph: (c) => invalidateGraph(c)
}

export function dispatchLiveEvent(client: Invalidator, e: LiveEvent): void {
  client.invalidateQueries({ queryKey: [e.resource, e.id] })
  client.invalidateQueries({ queryKey: [e.resource, 'list'] })
  OVERRIDES[e.resource]?.(client, e)
}
