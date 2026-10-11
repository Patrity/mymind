// Cycle 81 Task 4 — settings caches across processes (spec §3.6).
import { describe, expect, it, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ sendCommand: vi.fn(async () => undefined) }))
vi.mock('./commands', async importOriginal => ({ ...(await importOriginal<typeof import('./commands')>()), sendCommand: m.sendCommand }))

import { CACHE_INVALIDATORS, invalidateLocalCache, invalidateWorkerCache } from './invalidate'
import { invalidate as aiRegistry } from '../ai/registry/store'
import { invalidateChannelsConfig } from '../channels/config'
import { invalidateObsConfig } from '../observability/config'
import { invalidatePersona } from '../agent/persona'
import { invalidateSkillsEnabled } from '../agent/skills-config'
import { invalidateSearchConfig } from '../search/store'
import { invalidateImageConfig } from '../imagegen/store'
import { invalidateExecSecrets } from '../exec/secrets'

beforeEach(() => { vi.clearAllMocks() })

describe('cache invalidation across processes', () => {
  it('every cache name the bus carries maps to that store\'s OWN invalidator', () => {
    expect(CACHE_INVALIDATORS).toEqual({
      'ai-registry': aiRegistry, channels: invalidateChannelsConfig, observability: invalidateObsConfig,
      persona: invalidatePersona, skills: invalidateSkillsEnabled, search: invalidateSearchConfig,
      imagegen: invalidateImageConfig, 'exec-secrets': invalidateExecSecrets
    })
  })

  it('an unknown cache name fails the command loudly', () => {
    expect(() => invalidateLocalCache('nope' as never)).toThrow(/unknown cache/)
  })

  it('the web side sends one `invalidate` command; a failed send is logged, never thrown into the settings save', async () => {
    await invalidateWorkerCache('persona')
    expect(m.sendCommand).toHaveBeenCalledWith('invalidate', { cache: 'persona' })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    m.sendCommand.mockRejectedValueOnce(new Error('db down') as never)
    await expect(invalidateWorkerCache('skills')).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
