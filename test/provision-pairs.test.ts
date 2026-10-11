// Cycle 81 Task 2 review M6: deploy/provision-native.sh must pair EVERY plain env var core's mapper
// reads with its NUXT_ twin in .env.native. Otherwise a plain value set only in .env.native reaches
// the worker (runtime env) but not the web (build-baked runtimeConfig) and the two diverge.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { coreRuntimeConfig, fromEnv } from '@mymind/core/config-env'

/** The plain env keys coreRuntimeConfig reads — recorded through a Proxy env. */
function plainKeysRead(): string[] {
  const seen = new Set<string>()
  coreRuntimeConfig(new Proxy({}, { get: (_t, k) => { if (typeof k === 'string') seen.add(k); return undefined } }))
  return [...seen].sort()
}

const pairs = [...readFileSync('deploy/provision-native.sh', 'utf8').matchAll(/^\s*ensure_nuxt_override (\S+) (\S+)\s*$/gm)]
  .map(m => [m[1]!, m[2]!] as const)

describe('provision-native.sh NUXT_ pairing', () => {
  it('pairs every plain key the core mapper reads', () => {
    expect(pairs.map(p => p[0]).sort()).toEqual(plainKeysRead())
  })

  it.each(pairs)('%s → %s is the override the mapper actually honours', (plain, nuxt) => {
    expect(nuxt).toBe(`NUXT_${plain}`)
    // Setting only the NUXT_ twin must change what the worker (and, by the parity test, the web) sees.
    expect(fromEnv({ [nuxt]: 'sentinel-x' })).not.toEqual(fromEnv({}))
  })
})
