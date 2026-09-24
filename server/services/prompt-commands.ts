import { eq } from 'drizzle-orm'
import { useDb } from '../db'
import { promptCommands } from '../db/schema'
import { publishChange } from '../utils/live-bus'
import { RESERVED_COMMAND_NAMES, type CommandEntry } from '../../shared/types/commands'

function toEntry(r: typeof promptCommands.$inferSelect): CommandEntry {
  return { name: r.name, description: r.description, template: r.template, kind: 'prompt' }
}

export async function listPromptCommands(): Promise<CommandEntry[]> {
  const rows = await useDb().select().from(promptCommands).where(eq(promptCommands.active, true))
  return rows.map(toEntry)
}

export async function createPromptCommand(
  input: { name: string, description: string, template: string }
): Promise<CommandEntry> {
  // Reserved names are rejected HERE as well as in validateSkill (Task 3), because
  // both sources can claim a name and the merge would silently shadow the loser.
  if (RESERVED_COMMAND_NAMES.includes(input.name)) {
    throw new Error(`"${input.name}" is a reserved command name`)
  }
  const [row] = await useDb().insert(promptCommands).values(input).returning()
  // `document` is deliberately not a new `command`/`skill` ResourceName member — see
  // shared/types/live.ts. Skills are documents, and the composer's command-list query
  // is invalidated by document changes, so this is what makes a new macro appear in
  // the `/` menu without a reload.
  publishChange({ resource: 'document', action: 'created', id: row!.id })
  return toEntry(row!)
}
