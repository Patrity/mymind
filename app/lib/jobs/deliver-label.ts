/**
 * Pure label for a job's parsed `deliver` list (cycle 75), shown on JobStatusPanel. Messages
 * always land in the main thread, so "App" is always in the label even when `deliver` doesn't
 * spell out `app` explicitly. `auto` (iMessage only while Tony's away) is folded into an
 * unconditional `imessage` when both are present, rather than showing both.
 */
export function deliverLabel(deliver: string[]): string {
  const extras: string[] = []
  if (deliver.includes('imessage')) extras.push('iMessage')
  else if (deliver.includes('auto')) extras.push("iMessage when you're away")
  if (deliver.includes('email')) extras.push('Email')

  if (!extras.length) return 'App only'
  return ['App', ...extras].join(' · ')
}
