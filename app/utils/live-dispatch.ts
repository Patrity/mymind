import type { QueryClient } from '@tanstack/vue-query'
import type { LiveEvent, ResourceName } from '../../shared/types/live'

// Minimal surface we use — keeps the function unit-testable with a fake client.
type Invalidator = Pick<QueryClient, 'invalidateQueries'>

// The galaxy is a cross-type view keyed on ['graph'] alone (no id/list split), so
// any resource that can move a node or edge in it needs to invalidate that key too.
const invalidateGraph = (c: Invalidator) => c.invalidateQueries({ queryKey: ['graph'] })

// Per-resource override hook. Default behaviour (invalidate detail + list) covers
// every resource today; add an entry here only when a resource needs extra keys.
const OVERRIDES: Partial<Record<ResourceName, (c: Invalidator, e: LiveEvent) => void>> = {
  memory: (c) => { c.invalidateQueries({ queryKey: ['memory', 'count'] }); invalidateGraph(c) },
  review: (c) => c.invalidateQueries({ queryKey: ['review', 'count'] }),
  activity: (c) => c.invalidateQueries({ queryKey: ['activity', 'count'] }),
  document: (c) => invalidateGraph(c),
  image: (c) => invalidateGraph(c),
  session: (c) => invalidateGraph(c),
  project: (c) => invalidateGraph(c),
  graph: (c) => invalidateGraph(c)
}

export function dispatchLiveEvent(client: Invalidator, e: LiveEvent): void {
  client.invalidateQueries({ queryKey: [e.resource, e.id] })
  client.invalidateQueries({ queryKey: [e.resource, 'list'] })
  OVERRIDES[e.resource]?.(client, e)
}
