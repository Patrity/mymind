// Cycle 82 Task 3 (spec §6): the per-secret `sandbox` opt-in in the exec-secrets settings doc —
// default off, kept when a value is replaced, dropped when the secret is deleted. The dev DB's real
// doc is saved first and restored after (the dev DB is shared).
process.loadEnvFile('.env')
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
import { eq } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { settings } from '@mymind/core/db/schema'
import {
  deleteSecret, getSandboxOptedSecrets, invalidateExecSecrets, listSecretNames, setSecret, setSecretSandbox, UnknownSecretError
} from '@mymind/core/lib/exec/secrets'
import { sandboxSecretEnv } from '@mymind/core/lib/sandbox/secrets'

const KEY = 'exec_secrets'
let saved: { value: unknown } | undefined

describe('exec secrets: sandbox opt-in', () => {
  beforeAll(async () => {
    ;[saved] = await useDb().select({ value: settings.value }).from(settings).where(eq(settings.key, KEY))
    invalidateExecSecrets()
  })
  afterAll(async () => {
    if (saved) await useDb().update(settings).set({ value: saved.value as never }).where(eq(settings.key, KEY))
    else await useDb().delete(settings).where(eq(settings.key, KEY))
    invalidateExecSecrets()
  })

  it('defaults off; on → listed and returned; a reserved name is never handed to the sandbox; tainted → none', async () => {
    await setSecret('MM_T3_TOKEN', 'value-one-xyz')
    await setSecret('DOCKER_HOST', 'tcp://evil:2375')
    expect((await listSecretNames()).find(s => s.name === 'MM_T3_TOKEN')).toMatchObject({ sandbox: false })
    expect(await getSandboxOptedSecrets()).not.toHaveProperty('MM_T3_TOKEN')

    await setSecretSandbox('MM_T3_TOKEN', true)
    await setSecretSandbox('DOCKER_HOST', true) // the route refuses this; the injection strips it anyway
    invalidateExecSecrets() // re-read from the DB, not the cache
    expect((await listSecretNames()).find(s => s.name === 'MM_T3_TOKEN')).toMatchObject({ sandbox: true })
    expect(await getSandboxOptedSecrets()).toMatchObject({ MM_T3_TOKEN: 'value-one-xyz' })
    const env = await sandboxSecretEnv({ tainted: false })
    expect(env.MM_T3_TOKEN).toBe('value-one-xyz')
    expect(env).not.toHaveProperty('DOCKER_HOST')
    expect(await sandboxSecretEnv({ tainted: true })).toEqual({})
  })

  it('replacing a value keeps the opt-in; deleting drops it (a re-created secret starts off)', async () => {
    await setSecret('MM_T3_TOKEN', 'value-two-xyz')
    expect(await getSandboxOptedSecrets()).toMatchObject({ MM_T3_TOKEN: 'value-two-xyz' })
    await deleteSecret('MM_T3_TOKEN')
    await setSecret('MM_T3_TOKEN', 'value-three-xyz')
    expect((await listSecretNames()).find(s => s.name === 'MM_T3_TOKEN')).toMatchObject({ sandbox: false })
    await setSecretSandbox('MM_T3_TOKEN', false)
    await deleteSecret('MM_T3_TOKEN')
    await deleteSecret('DOCKER_HOST')
  })

  it('an unknown secret cannot be opted in', async () => {
    await expect(setSecretSandbox('MM_T3_NOPE', true)).rejects.toBeInstanceOf(UnknownSecretError)
  })
})
