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

/** Move a highlighted menu index by `delta`, wrapping around a list of `length`
 *  entries. A `length` of 0 (nothing filtered in) always yields 0 — there is
 *  nothing to highlight, and the caller is expected to let Enter fall through
 *  to a normal submit in that case rather than call this at all. */
export function nextHighlight(current: number, length: number, delta: number): number {
  if (length <= 0) return 0
  return ((current + delta) % length + length) % length
}

/** Should the composer's command menu intercept this Enter instead of submitting?
 *  Shift+Enter always belongs to the textarea (newline), and with nothing to pick
 *  there is nothing to intercept — `/xyz` matching no command must still send as text. */
export function shouldInterceptEnter(
  e: { key: string, shiftKey: boolean },
  filteredLength: number
): boolean {
  return e.key === 'Enter' && !e.shiftKey && filteredLength > 0
}
