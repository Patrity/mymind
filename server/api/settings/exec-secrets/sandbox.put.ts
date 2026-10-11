// Cycle 82 Task 3 (spec §6): opt a secret in to (or out of) the workspace sandbox. Session only. The
// worker caches the secrets, so it is told to drop its copy. Names the docker CLI or the sandbox env
// own (DOCKER_*, HOME, PATH, LANG, …) can't be opted in — they would steer the CLI or clobber the env.
import { z } from 'zod'
import { setSecretSandbox, UnknownSecretError } from '@mymind/core/lib/exec/secrets'
import { isSandboxSecretName } from '@mymind/core/lib/sandbox/secrets'
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
  try { await setSecretSandbox(name, sandbox) } catch (err) {
    if (err instanceof UnknownSecretError) throw createError({ statusCode: 404, statusMessage: 'Not found', data: { message: err.message } })
    throw err
  }
  await invalidateWorkerCache('exec-secrets')
  return { ok: true, name, sandbox }
})
