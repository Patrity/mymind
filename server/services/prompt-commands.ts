import { eq } from 'drizzle-orm'
import { useDb } from '../db'
import { promptCommands } from '../db/schema'
import { publishChange } from '../utils/live-bus'
import { COMMAND_NAME_RE, RESERVED_COMMAND_NAMES, type CommandEntry } from '../../shared/types/commands'

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
  // Macros had NO shape validation at all, in the service or as a CHECK on the column, while
  // skills had SKILL_NAME_RE — so `daily standup` inserted happily and was permanently
  // unreachable (parseCommand stops at the first whitespace) and `Clear` dodged the built-in's
  // shadowing (mergeCommands keys on the exact string; the menu filters case-insensitively).
  // Validate and store the TRIMMED name: unlike skills, the raw name here is also what gets
  // written, so `' clear '` produced a dead row rather than a shadowed one.
  const name = input.name.trim()
  if (!COMMAND_NAME_RE.test(name)) {
    throw new Error(`name must be kebab-case (got "${input.name}")`)
  }
  // Reserved names are rejected HERE as well as in validateSkill (Task 3), because
  // both sources can claim a name and the merge would silently shadow the loser.
  if (RESERVED_COMMAND_NAMES.includes(name)) {
    throw new Error(`"${name}" is a reserved command name`)
  }
  // `template` is notNull but '' satisfies that, and an empty template makes the composer
  // fall through both dispatch branches and send the literal "/name" to the model.
  const template = input.template.trim()
  if (!template) throw new Error('template is required')
  const [row] = await useDb().insert(promptCommands).values({ ...input, name, template }).returning()
  // `document` is deliberately not a new `command`/`skill` ResourceName member — see
  // shared/types/live.ts. Skills are documents, and the composer's command-list query
  // is invalidated by document changes, so this is what makes a new macro appear in
  // the `/` menu without a reload.
  publishChange({ resource: 'document', action: 'created', id: row!.id })
  return toEntry(row!)
}
