import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { CLIENT_COMMANDS, type CommandEntry } from '~~/shared/types/commands'

/** Pure so the fallback rule is testable without vue-query. */
export function commandsOrFallback(fetched: CommandEntry[] | undefined, isError: boolean): CommandEntry[] {
  if (isError || fetched === undefined) return CLIENT_COMMANDS
  return fetched
}

/**
 * The `/` menu's entries.
 *
 * Keyed so the live bus can invalidate it: skills ARE documents, and there is no
 * `skill` member of ResourceName, so a `document` live event invalidates this query
 * too (see app/utils/live-dispatch.ts's `document` override) — that is what makes a
 * newly-created macro/skill appear in the `/` menu without a reload. `staleTime` is
 * kept anyway as a cheap floor for tabs that never receive that event.
 */
export function useCommands() {
  const { data, isError } = useQuery({
    queryKey: ['agent', 'commands'],
    queryFn: () => $fetch<CommandEntry[]>('/api/agent/commands'),
    staleTime: 30_000
  })
  return {
    commands: computed(() => commandsOrFallback(data.value, isError.value)),
    isError
  }
}
