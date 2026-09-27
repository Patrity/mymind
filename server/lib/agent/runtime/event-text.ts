// How an `event` row (role='event') reads to the MODEL. Deliberately a plain sentence with no
// brackets or tags: the model imitates whatever its history looks like (the `[image]` and
// repeated-marker incidents), and a marker here would reappear in its replies.
export function wakeOrigin(reason: string): string { return `wake:${reason}` }

export function eventModelText(origin: string | null, content: string): string {
  const [kind, detail] = (origin ?? '').split(':', 2)
  if (kind === 'wake') return `Background wake (${detail || 'unspecified'}): ${content}`
  if (kind === 'review') return `Note (review ${detail || 'update'}): ${content}`
  if (kind === 'runtime') return `Note (${detail || 'runtime'}): ${content}`
  return `Note: ${content}`
}
