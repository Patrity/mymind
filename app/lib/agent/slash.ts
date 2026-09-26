/**
 * Slash-command trigger rules for the agent composer.
 *
 * Deliberately narrow: `/` only means "open the menu" as the FIRST character, and
 * only until the name is settled. Anything looser fires on file paths and dates.
 */
import type { CommandEntry } from '~~/shared/types/commands'

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

/** Is the menu actually ON SCREEN? The `<ul>` renders on open AND non-empty, so keyboard
 *  handling must gate on this rather than on `shouldOpenMenu` alone: with `/zzz` typed the
 *  menu is "open" with zero matches, and swallowing ArrowUp/ArrowDown/Escape against nothing
 *  visible leaves the user unable to move the caret with no idea why. */
export function isMenuVisible(open: boolean, filteredLength: number): boolean {
  return open && filteredLength > 0
}

/** What a submitted line becomes once the `/`-command (if any) has been resolved. */
export interface Submission {
  /** The turn's text. Empty only when `clientCommand` is set — nothing is sent for those. */
  text: string
  /** `skill` kind: forwarded onto the WS frame so assembleContext can load the body. */
  skillName?: string
  /** `client` kind: the page maps this onto a control frame; no turn is sent. */
  clientCommand?: string
}

/**
 * The composer's three-way dispatch, extracted whole so it can be tested without a browser.
 * `cmd` is `parseCommand(text)` and `entry` is the matching live command (undefined when the
 * name matches nothing — an unknown `/foo` is ordinary text, not an error).
 */
export function resolveSubmission(
  text: string,
  cmd: { name: string, args: string } | null,
  entry: CommandEntry | undefined
): Submission {
  if (!cmd || !entry) return { text }

  if (entry.kind === 'client') return { text: '', clientCommand: entry.name }

  if (entry.kind === 'prompt' && entry.template) {
    // Substitute before submitting so the transcript shows what the model actually
    // received (the expanded template), rather than an opaque "/standup".
    return { text: cmd.args ? `${entry.template}\n\n${cmd.args}` : entry.template }
  }

  if (entry.kind === 'skill') {
    // The typed line goes through VERBATIM, slash and all — `/db-maintenance`, or
    // `/db-maintenance check the indexes`. Two earlier shapes were both wrong:
    // sending only `cmd.args` left a bare invocation empty, which tripped onSubmit's
    // `!text` guard AFTER submitForm had cleared the box (pick from the menu, hit Enter,
    // lose your input); substituting "Use the <name> skill." fixed the emptiness but
    // erased the command, so the transcript — and the model reading it back — never saw
    // that a slash command existed at all. Keeping the raw line is what makes the agent
    // aware of its own command surface, and it is what a fork/edit of the turn replays.
    // The body still arrives out-of-band as the skill tier; this is only the message.
    return { text, skillName: entry.name }
  }

  // A `prompt` entry with an empty template lands here and sends the raw "/name". The row
  // should not exist (createPromptCommand rejects an empty template), but a hand-inserted
  // one must degrade to text rather than to nothing.
  return { text }
}
