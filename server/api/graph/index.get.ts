// Real galaxy graph, read from the computed graph_layout (Task 2.4). Nodes come
// from graph_layout joined to their live source rows; edges are assembled from
// the source-table FKs + active memory_relations. Empty until the layout job has
// run at least once (nightly, or POST /api/graph/recompute).
//
// Auth-gated by server/middleware/auth.ts (only logged-in sessions / API tokens
// reach here) — same implicit guard as events.get.ts and search.get.ts; no
// explicit call needed here.
import { getGraph } from '../../services/graph'

export default defineEventHandler(() => getGraph())
