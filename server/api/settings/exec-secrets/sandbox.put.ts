// Cycle 82 Task 3 (spec §6): opt a secret in to (or out of) the workspace sandbox. Session only. The
// worker caches the secrets, so it is told to drop its copy. Names the docker CLI or the sandbox env
// own (DOCKER_*, HOME, PATH, LANG, …) can't be opted in — they would steer the CLI or clobber the env —
// and neither can a value under 4 characters (it couldn't be masked out of output).
import { z } from 'zod'
import { getDecryptedSecrets, setSecretSandbox, UnknownSecretError } from '@mymind/core/lib/exec/secrets'
import { isSandboxSecretName, MIN_SANDBOX_SECRET_CHARS } from '@mymind/core/lib/sandbox/secrets'
import { invalidateWorkerCache } from '@mymind/core/lib/bus/invalidate'
import { requireSession } from '../../../utils/auth-guard'

const Body = z.object({ name: z.string().min(1).max(200), sandbox: z.boolean() })

export default defineEventHandler(async (event) => {
  requireSession(event)
  const b = Body.safeParse(await readBody(event))
  if (!b.success) throw createError({ statusCode: 400, statusMessage: 'Bad request', data: { message: 'name and sandbox (boolean) are required' } })
  const { name, sandbox } = b.data
  if (sandbox && !isSandboxSecretName(name)) {
    throw createError({ statusCode: 400, statusMessage: 'Reserved name', data: { message: `${name} is reserved in the sandbox (it would steer the docker CLI or replace the sandbox's own environment) — store it under another name.` } })
  }
  if (sandbox) {
    // Fix round 1 (M2): a value this short can't be masked out of command output without mangling it.
    const value = (await getDecryptedSecrets())[name]
    if (value !== undefined && value.length < MIN_SANDBOX_SECRET_CHARS) {
      throw createError({ statusCode: 400, statusMessage: 'Value too short', data: { message: `${name} is shorter than ${MIN_SANDBOX_SECRET_CHARS} characters — too short to keep out of command output, so it can't go into the sandbox.` } })
    }
  }
  try { await setSecretSandbox(name, sandbox) } catch (err) {
    if (err instanceof UnknownSecretError) throw createError({ statusCode: 404, statusMessage: 'Not found', data: { message: err.message } })
    throw err
  }
  await invalidateWorkerCache('exec-secrets')
  return { ok: true, name, sandbox }
})
