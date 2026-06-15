import { z } from 'zod'
import { loadObsConfig, saveObsConfig, invalidateObsConfig, parseObsConfig } from '../../lib/observability/config'
import { encryptSecret } from '../../lib/ai/registry/crypto'
import { ACTIVITY_KINDS } from '../../../shared/types/activity'

const KeyField = z.union([z.object({ apiKey: z.string().min(1) }), z.object({ keep: z.literal(true) }), z.null()])
const Body = z.object({
  version: z.literal(1),
  retainInfoDays: z.number().int().positive(),
  retainErrorDays: z.number().int().positive(),
  maxRows: z.number().int().positive(),
  capture: z.object(Object.fromEntries(ACTIVITY_KINDS.map(k => [k, z.boolean()]))),
  alerts: z.object({
    badge: z.boolean(),
    toast: z.boolean(),
    email: z.object({
      enabled: z.boolean(),
      recipient: z.string().email().nullable(),
      from: z.string().email().nullable(),
      key: KeyField,
      minSeverity: z.enum(['warn', 'error']),
      digestWindowMin: z.number().int().positive()
    })
  })
})

export default defineEventHandler(async (event) => {
  let body: z.infer<typeof Body>
  try { body = Body.parse(await readBody(event)) }
  catch (err) { throw createError({ statusCode: 422, statusMessage: 'Invalid config', data: (err as Error).message }) }

  const existing = await loadObsConfig()
  let apiKeyEnc: string | null = null
  const k = body.alerts.email.key
  if (k && 'apiKey' in k) apiKeyEnc = encryptSecret(k.apiKey)
  else if (k && 'keep' in k) apiKeyEnc = existing.alerts.email.apiKeyEnc
  else apiKeyEnc = null

  const doc = parseObsConfig({
    version: 1,
    retainInfoDays: body.retainInfoDays,
    retainErrorDays: body.retainErrorDays,
    maxRows: body.maxRows,
    capture: body.capture,
    alerts: {
      badge: body.alerts.badge,
      toast: body.alerts.toast,
      email: {
        enabled: body.alerts.email.enabled,
        recipient: body.alerts.email.recipient,
        from: body.alerts.email.from,
        apiKeyEnc,
        minSeverity: body.alerts.email.minSeverity,
        digestWindowMin: body.alerts.email.digestWindowMin
      }
    }
  })
  await saveObsConfig(doc)
  invalidateObsConfig()
  return { ok: true }
})
