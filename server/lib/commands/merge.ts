import type { CommandEntry, CommandKind } from '../../../shared/types/commands'

const PRECEDENCE: CommandKind[] = ['client', 'prompt', 'skill']

/**
 * Merge the three command sources into one flat namespace.
 *
 * Precedence is code > prompt > skill. The winner carries `shadows` listing every
 * source it displaced, so a skill that silently stopped being reachable is
 * explainable from the UI instead of just missing.
 */
export function mergeCommands(sources: {
  client: CommandEntry[]
  prompt: CommandEntry[]
  skill: CommandEntry[]
}): CommandEntry[] {
  const byName = new Map<string, CommandEntry>()

  for (const kind of PRECEDENCE) {
    for (const entry of sources[kind]) {
      const existing = byName.get(entry.name)
      if (!existing) {
        byName.set(entry.name, { ...entry, kind })
        continue
      }
      // A lower-precedence source lost. Record the LOSER's kind on the winner —
      // losers are never returned, so this is the only trace the UI gets.
      // Only record if it's a different source; within the same source, first wins silently.
      if (existing.kind !== kind) {
        byName.set(entry.name, { ...existing, shadows: [...(existing.shadows ?? []), kind] })
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
