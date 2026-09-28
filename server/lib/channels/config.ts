// server/lib/channels/config.ts
// Channel settings (cycle 75): iMessage via BlueBubbles, email via Resend, presence window.
// Three `settings` keys, each owned here (mirrors server/lib/observability/config.ts):
//   channel_imessage       { enabled, serverUrl, passwordEnc, webhookToken, allowedHandles, defaultHandle, defaultChatGuid }
//   channel_email          { enabled, to }            — sender + API key come from the Resend alert config
//   presence_away_minutes  number (default 10)
// The BlueBubbles password is stored encrypted and never leaves the server. The webhook token
// appears in exactly one response: the session-authed settings GET, inside `webhookUrlPath`,
// so Tony can paste it into BlueBubbles (controller ruling, cycle 75).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { inArray } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import { encryptSecret, decryptSecret } from '../ai/registry/crypto'
import { normaliseHandle } from './handles'
import { loadObsConfig } from '../observability/config'

const KEY_IMESSAGE = 'channel_imessage'
const KEY_EMAIL = 'channel_email'
const KEY_PRESENCE = 'presence_away_minutes'

export const PRESENCE_MIN = 1
export const PRESENCE_MAX = 240
export const PRESENCE_DEFAULT = 10

export interface IMessageConfig { enabled: boolean, serverUrl: string, passwordEnc: string | null, webhookToken: string, allowedHandles: string[], defaultHandle: string | null, defaultChatGuid: string | null }
export interface EmailChannelConfig { enabled: boolean, to: string | null }
export interface ChannelsConfig { imessage: IMessageConfig, email: EmailChannelConfig, presenceAwayMinutes: number }
export interface ChannelsConfigDTO {
  imessage: Omit<IMessageConfig, 'passwordEnc' | 'webhookToken'> & { hasPassword: boolean, webhookUrlPath: string }
  email: EmailChannelConfig & { resendReady: boolean }
  presenceAwayMinutes: number
}

/** A PUT that is well-formed but semantically invalid (e.g. a default handle outside the allowlist). */
export class ChannelsConfigError extends Error {
  readonly statusCode = 400
  constructor(message: string) { super(message); this.name = 'ChannelsConfigError' }
}

export function newWebhookToken(): string {
  return randomBytes(32).toString('hex')
}

const imessageSchema = z.object({
  enabled: z.boolean().default(false),
  serverUrl: z.string().default(''),
  passwordEnc: z.string().nullable().default(null),
  webhookToken: z.string().min(1).optional(),
  allowedHandles: z.array(z.string()).default([]),
  defaultHandle: z.string().nullable().default(null),
  defaultChatGuid: z.string().nullable().default(null)
})
const emailSchema = z.object({
  enabled: z.boolean().default(false),
  to: z.string().nullable().default(null)
})

/**
 * Parse the three stored values into a config. When the iMessage row has no webhook token a
 * fresh one is generated here; persisting it is the caller's job (`loadChannelsConfig` does).
 */
export function parseChannelsConfig(raw: { imessage?: unknown, email?: unknown, presenceAwayMinutes?: unknown }): ChannelsConfig {
  const im = imessageSchema.parse(raw.imessage ?? {})
  const email = emailSchema.parse(raw.email ?? {})
  const mins = z.number().int().min(PRESENCE_MIN).max(PRESENCE_MAX).safeParse(raw.presenceAwayMinutes)
  return {
    imessage: { ...im, webhookToken: im.webhookToken ?? newWebhookToken() },
    email,
    presenceAwayMinutes: mins.success ? mins.data : PRESENCE_DEFAULT
  }
}

export function webhookUrlPath(token: string): string {
  return `/api/channels/bluebubbles/webhook?token=${token}`
}

export function redactChannelsConfig(c: ChannelsConfig, resendReady: boolean): ChannelsConfigDTO {
  const { passwordEnc, webhookToken, ...im } = c.imessage
  return {
    imessage: { ...im, hasPassword: passwordEnc !== null, webhookUrlPath: webhookUrlPath(webhookToken) },
    email: { ...c.email, resendReady },
    presenceAwayMinutes: c.presenceAwayMinutes
  }
}

export function blueBubblesPassword(c: IMessageConfig): string | null {
  return c.passwordEnc ? decryptSecret(c.passwordEnc) : null
}

// PUT body — mirrors the DTO (unknown DTO-only keys like hasPassword/webhookUrlPath/resendReady/
// defaultChatGuid are stripped by zod) plus a write-only password field.
const PasswordField = z.union([
  z.object({ password: z.string().min(1) }),
  z.object({ keep: z.literal(true) }),
  z.null()
])
export const ChannelsPutBodySchema = z.object({
  imessage: z.object({
    enabled: z.boolean(),
    serverUrl: z.union([z.literal(''), z.string().trim().url()]),
    password: PasswordField,
    allowedHandles: z.array(z.string()),
    defaultHandle: z.string().nullable()
  }),
  email: z.object({
    enabled: z.boolean(),
    to: z.union([z.literal(''), z.string().trim().email()]).nullable()
  }),
  presenceAwayMinutes: z.number()
})
export type ChannelsPutBody = z.infer<typeof ChannelsPutBodySchema>

/** Apply a validated PUT body to the stored config. Throws ChannelsConfigError (400) on a bad default handle. */
export function mergeChannelsPut(existing: ChannelsConfig, body: ChannelsPutBody): ChannelsConfig {
  const pw = body.imessage.password
  const passwordEnc = pw === null
    ? null
    : 'password' in pw ? encryptSecret(pw.password) : existing.imessage.passwordEnc

  const allowedHandles = [...new Set(body.imessage.allowedHandles.map(normaliseHandle).filter(Boolean))]
  const defaultHandle = body.imessage.defaultHandle ? normaliseHandle(body.imessage.defaultHandle) || null : null
  if (defaultHandle !== null && !allowedHandles.includes(defaultHandle)) {
    throw new ChannelsConfigError('defaultHandle must be one of the allowed handles')
  }
  const defaultChatGuid = defaultHandle === existing.imessage.defaultHandle ? existing.imessage.defaultChatGuid : null

  const mins = Math.round(body.presenceAwayMinutes)
  return {
    imessage: {
      enabled: body.imessage.enabled,
      serverUrl: body.imessage.serverUrl.replace(/\/+$/, ''),
      passwordEnc,
      webhookToken: existing.imessage.webhookToken,
      allowedHandles,
      defaultHandle,
      defaultChatGuid
    },
    email: { enabled: body.email.enabled, to: body.email.to ? body.email.to.toLowerCase() : null },
    presenceAwayMinutes: Math.min(PRESENCE_MAX, Math.max(PRESENCE_MIN, Number.isFinite(mins) ? mins : PRESENCE_DEFAULT))
  }
}

let cache: ChannelsConfig | null = null

async function upsert(key: string, value: unknown): Promise<void> {
  const now = new Date()
  await useDb().insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
}

export async function loadChannelsConfig(): Promise<ChannelsConfig> {
  if (cache) return cache
  const rows = await useDb().select().from(settings)
    .where(inArray(settings.key, [KEY_IMESSAGE, KEY_EMAIL, KEY_PRESENCE]))
  const byKey = new Map(rows.map(r => [r.key, r.value]))
  const rawIm = byKey.get(KEY_IMESSAGE) as { webhookToken?: unknown } | undefined
  const c = parseChannelsConfig({ imessage: rawIm, email: byKey.get(KEY_EMAIL), presenceAwayMinutes: byKey.get(KEY_PRESENCE) })
  // First load (or a row without a token): persist the generated token so it stays stable.
  if (typeof rawIm?.webhookToken !== 'string' || !rawIm.webhookToken) await upsert(KEY_IMESSAGE, c.imessage)
  cache = c
  return c
}

export async function saveChannelsConfig(c: ChannelsConfig): Promise<void> {
  const validated = parseChannelsConfig({ imessage: c.imessage, email: c.email, presenceAwayMinutes: c.presenceAwayMinutes })
  await upsert(KEY_IMESSAGE, validated.imessage)
  await upsert(KEY_EMAIL, validated.email)
  await upsert(KEY_PRESENCE, validated.presenceAwayMinutes)
  cache = validated
}

export function invalidateChannelsConfig(): void { cache = null }

/** Constant-time check of the BlueBubbles webhook token; false while iMessage is disabled. */
export async function verifyWebhookToken(token: string | undefined): Promise<boolean> {
  const c = await loadChannelsConfig()
  if (!c.imessage.enabled || !token) return false
  const a = Buffer.from(token), b = Buffer.from(c.imessage.webhookToken)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Email can be sent when the Resend alert config has an API key and a sender address. */
export async function resendReady(): Promise<boolean> {
  const e = (await loadObsConfig()).alerts.email
  return e.apiKeyEnc !== null && e.from !== null
}

/** The settings GET/PUT/regenerate response. */
export async function channelsConfigDTO(c: ChannelsConfig): Promise<ChannelsConfigDTO> {
  return redactChannelsConfig(c, await resendReady())
}
