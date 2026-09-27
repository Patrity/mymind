// Rollback lever for one cycle: agent_runtime=false in settings routes ws.ts to the legacy
// in-socket path. Read ONCE at boot (the WS open hook is synchronous); flipping it needs a
// restart. Cycle 74 deletes the legacy path and this file.
import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { settings } from '../../../db/schema'

export const AGENT_RUNTIME_KEY = 'agent_runtime'
let enabled = true
export function runtimeEnabled(): boolean { return enabled }
export async function loadRuntimeFlag(): Promise<boolean> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, AGENT_RUNTIME_KEY)).limit(1)
  const v = row?.value as { enabled?: unknown } | undefined
  enabled = typeof v?.enabled === 'boolean' ? v.enabled : true
  return enabled
}
