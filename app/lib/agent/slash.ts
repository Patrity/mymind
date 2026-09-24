/**
 * Slash-command trigger rules for the agent composer.
 *
 * Deliberately narrow: `/` only means "open the menu" as the FIRST character, and
 * only until the name is settled. Anything looser fires on file paths and dates.
 */

/** The menu is open while the input is a slash followed by a partial name. */
export function shouldOpenMenu(text: string): boolean {
  return /^\/[^\s]*$/.test(text)
}

/** What the menu filters on — everything after the slash. */
export function menuQuery(text: string): string {
  return shouldOpenMenu(text) ? text.slice(1) : ''
}

/** Split a submitted line into command name and the rest, or null if it is not a command. */
export function parseCommand(text: string): { name: string, args: string } | null {
  const m = /^\/([^\s]+)\s*([\s\S]*)$/.exec(text)
  if (!m) return null
  return { name: m[1]!, args: m[2]!.trim() }
}

/** What the input becomes when a menu entry is chosen. The trailing space is
 *  deliberate: the cursor lands where arguments go, and selection never submits. */
export function applySelection(name: string): string {
  return `/${name} `
}
