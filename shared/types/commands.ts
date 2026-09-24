/** How a `/command` dispatches once submitted. */
export type CommandKind = 'client' | 'prompt' | 'skill'

export interface CommandEntry {
  /** Bare name with no leading slash, e.g. `browser-testing`. */
  name: string
  description: string
  /** Secondary menu line. For skills this is `whenToUse`. */
  hint?: string
  kind: CommandKind
  /** `prompt` kind only — the text the composer substitutes before submitting. */
  template?: string
  /** Lower-precedence sources that also claimed this name and lost. Carried by the
   *  WINNER, because losers are not returned — this is how the UI explains why a
   *  skill you created is unreachable. */
  shadows?: CommandKind[]
}

/**
 * Client-kind commands live in code, not the database: each maps to behaviour that
 * must exist in the bundle anyway, and a DB row naming a WS message the client
 * cannot send is a silent no-op. This is also the composer's offline fallback when
 * the endpoint fails — a server error must never cost you `/clear`.
 */
export const CLIENT_COMMANDS: CommandEntry[] = [
  { name: 'clear', kind: 'client', description: 'Clear this conversation', hint: 'Bridget forgets the transcript; nothing is deleted' },
  { name: 'new', kind: 'client', description: 'Start a new conversation', hint: 'Leaves the current one intact' }
]

/** Names no skill or macro may take. Derived, so it cannot drift from the list above. */
export const RESERVED_COMMAND_NAMES: string[] = CLIENT_COMMANDS.map(c => c.name)
