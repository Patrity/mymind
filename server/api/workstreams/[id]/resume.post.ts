// Auth: session OR API token, like agent/chat.post.ts (controller ruling, Task 6 fix round 1).
import { requireWorkstreamId, sendWorkstreamControl } from '../../../utils/workstreams-http'

/** Resume a failed/cancelled (or waiting) workstream. A used-up budget is extended by
 *  RESUME_EXTENSION (shared/types/workstreams.ts) — the UI says so on the button. */
export default defineEventHandler(async event => sendWorkstreamControl(requireWorkstreamId(event), 'resume'))
