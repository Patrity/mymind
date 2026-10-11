import { requireWorkstreamId, sendWorkstreamControl } from '../../../utils/workstreams-http'

/** Cancel: a running segment stops after its current step (the worker holds it). */
export default defineEventHandler(async event => sendWorkstreamControl(requireWorkstreamId(event), 'cancel'))
