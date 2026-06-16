import type { MemoryScope } from '../../../shared/types/memory'

/** Agent-scope memories inherit the session's project; user/world are global. Pure. */
export function projectIdForScope(scope: MemoryScope, sessionProjectId: string | null): string | null {
  return scope === 'agent' ? (sessionProjectId ?? null) : null
}
