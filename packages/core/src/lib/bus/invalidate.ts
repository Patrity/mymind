// Settings caches across processes (cycle 81, spec §3.6). Each settings store keeps a module-level
// cache per process; the web's settings routes write (and refresh their own copy), and then tell the
// worker with an `invalidate` command so its next read goes to the DB. One entry per
// InvalidateCache name — the worker's handler and the routes both go through this map, so a cache
// name can never be sent that the worker doesn't know.
import type { InvalidateCache } from './commands'
import { sendCommand } from './commands'
import { invalidate as invalidateAiRegistry } from '../ai/registry/store'
import { invalidateChannelsConfig } from '../channels/config'
import { invalidateObsConfig } from '../observability/config'
import { invalidatePersona } from '../agent/persona'
import { invalidateSkillsEnabled } from '../agent/skills-config'
import { invalidateSearchConfig } from '../search/store'
import { invalidateImageConfig } from '../imagegen/store'
import { invalidateExecSecrets } from '../exec/secrets'

export const CACHE_INVALIDATORS: Readonly<Record<InvalidateCache, () => void>> = {
  'ai-registry': invalidateAiRegistry,
  channels: invalidateChannelsConfig,
  observability: invalidateObsConfig,
  persona: invalidatePersona,
  skills: invalidateSkillsEnabled,
  search: invalidateSearchConfig,
  imagegen: invalidateImageConfig,
  'exec-secrets': invalidateExecSecrets
}

/** Worker: drop this process's copy of `cache` (the `invalidate` command). */
export function invalidateLocalCache(cache: InvalidateCache): void {
  const fn = CACHE_INVALIDATORS[cache]
  if (!fn) throw new Error(`unknown cache "${String(cache)}"`)
  fn()
}

/**
 * Web: after a settings write (and the route's own local refresh), tell the worker to drop its copy.
 * Awaits only the INSERT + NOTIFY — not the worker — so a settings save never hangs on a slow or
 * offline worker. Ordering still holds for the next turn: commands are claimed through one serial
 * intake in id order and this handler is synchronous, so a `kick` sent after this returns runs only
 * after the cache is gone. A worker that is down re-reads everything when it boots. A failed send is
 * logged, never thrown — the write itself succeeded.
 */
export async function invalidateWorkerCache(cache: InvalidateCache): Promise<void> {
  try {
    await sendCommand('invalidate', { cache })
  } catch (err) {
    console.error(`[bus] could not tell the agent worker to invalidate "${cache}":`, err)
  }
}
