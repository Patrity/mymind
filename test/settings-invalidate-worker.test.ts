// Cycle 81 Task 4 (spec §3.6) — every web route that WRITES a setting the worker caches must tell
// the worker to drop its copy. A source guard, because the failure mode is silent: the worker keeps
// using the old model / persona / secrets until it restarts. A route that calls one of these store
// writers must call invalidateWorkerCache with that store's cache name.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Store writer → the InvalidateCache name the worker knows it by (lib/bus/invalidate.ts).
const WRITERS: Record<string, string> = {
  saveConfig: 'ai-registry',
  saveChannelsConfig: 'channels', rotateWebhookToken: 'channels',
  saveObsConfig: 'observability',
  savePersona: 'persona',
  setSkillsEnabled: 'skills',
  saveSearchConfig: 'search',
  saveImageConfig: 'imagegen',
  setSecret: 'exec-secrets', deleteSecret: 'exec-secrets'
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : (p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [])
  })
}

describe('settings writes reach the worker', () => {
  const routes = files('server').map(p => ({ p, src: readFileSync(p, 'utf8') }))
  const writing = routes.flatMap(({ p, src }) => Object.entries(WRITERS)
    .filter(([fn]) => new RegExp(`\\b${fn}\\(`).test(src))
    .map(([fn, cache]) => ({ p, fn, cache, src })))

  it('finds the known writers (the guard is not vacuous)', () => {
    expect(new Set(writing.map(w => w.p.replace(/\\/g, '/')))).toEqual(new Set([
      'server/api/settings/ai-config.put.ts', 'server/api/settings/import-env.post.ts',
      'server/api/settings/channels.put.ts', 'server/api/settings/channels/regenerate-token.post.ts',
      'server/api/settings/observability-config.put.ts', 'server/api/settings/persona.put.ts',
      'server/api/settings/skills-enabled.put.ts', 'server/api/settings/search.put.ts',
      'server/api/settings/image-config.put.ts', 'server/api/settings/exec-secrets.put.ts',
      'server/api/settings/exec-secrets.delete.ts'
    ]))
  })

  it.each(Object.entries(WRITERS))('a route calling %s sends invalidate for its cache', (fn) => {
    for (const w of writing.filter(x => x.fn === fn)) {
      expect(w.src, `${w.p} calls ${fn}( but never invalidateWorkerCache('${w.cache}')`).toContain(`invalidateWorkerCache('${w.cache}')`)
    }
  })
})
