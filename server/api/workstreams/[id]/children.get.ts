import { childrenOf, workstreamDTOs } from '@mymind/core/lib/agent/workstreams/store'
import { requireWorkstreamId } from '../../../utils/workstreams-http'

/** Cycle 83 (spec §6): a coordinator's children, oldest first — the detail page's Children panel.
 *  Empty for a workstream with none (or an unknown id). Read-only, like the other GETs. */
export default defineEventHandler(async event => workstreamDTOs(await childrenOf(requireWorkstreamId(event))))
