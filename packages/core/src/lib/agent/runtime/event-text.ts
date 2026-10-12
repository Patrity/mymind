// How an `event` row (role='event') reads to the MODEL. Deliberately a plain sentence with no
// brackets or tags: the model imitates whatever its history looks like (the `[image]` and
// repeated-marker incidents), and a marker here would reappear in its replies.
import { splitOrigin } from '../../../shared/utils/event-origin'

export function wakeOrigin(reason: string): string { return `wake:${reason}` }

export function eventModelText(origin: string | null, content: string): string {
  const { kind, detail } = splitOrigin(origin)
  if (kind === 'wake') return `Background wake (${detail || 'unspecified'}): ${content}`
  if (kind === 'review') return `Note (review ${detail || 'update'}): ${content}`
  if (kind === 'runtime') return `Note (${detail || 'runtime'}): ${content}`
  // Cycle 81: a workstream's report into the chat it was started from (the detail is its id — not
  // for the model).
  if (kind === 'workstream') return `Workstream update: ${content}`
  // Cycle 83 final fix wave (M2): a child workstream's coordinator speaking — not Tony.
  if (kind === 'coordinator') return `[from your coordinator] ${content}`
  return `Note: ${content}`
}
