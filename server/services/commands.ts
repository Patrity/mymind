import { mergeCommands } from '../lib/commands/merge'
import { listPromptCommands } from './prompt-commands'
import { listSkills } from './skills'
import { CLIENT_COMMANDS, type CommandEntry } from '../../shared/types/commands'

/**
 * The flat `/` namespace: code constants + prompt macros + every active skill.
 *
 * `q` filters server-side for callers that want it. The composer does NOT use it —
 * the shadcn/reka `Command` primitive is ListboxRoot with useFilter built in, so
 * filtering is already local and instant, and a round-trip per keystroke would make
 * the menu laggy for no gain.
 */
export async function listCommands(q?: string): Promise<CommandEntry[]> {
  const [prompt, skills] = await Promise.all([listPromptCommands(), listSkills({ activeOnly: true })])

  const skill: CommandEntry[] = skills.map(s => ({
    name: s.name,
    description: s.description,
    hint: s.whenToUse,
    kind: 'skill' as const
  }))

  const merged = mergeCommands({ client: CLIENT_COMMANDS, prompt, skill })

  const needle = q?.trim().toLowerCase()
  if (!needle) return merged
  return merged.filter(c =>
    c.name.toLowerCase().includes(needle) || c.description.toLowerCase().includes(needle))
}
