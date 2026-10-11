// Auth: session OR API token (the auth middleware). Stopping or steering a workstream never widens
// what it may do; starting and resuming need a session (final review I5, see index.post.ts).
import { requireWorkstreamId, sendWorkstreamControl } from '../../../utils/workstreams-http'

/** Cancel: a running segment stops after its current step (the worker holds it). */
export default defineEventHandler(async event => sendWorkstreamControl(requireWorkstreamId(event), 'cancel'))
