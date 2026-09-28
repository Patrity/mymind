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
import { eq, inArray, sql } from 'drizzle-orm'
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

// Field-by-field schemas for the STORED rows. Parsing is tolerant: a malformed field (e.g. a
// hand-edited `enabled: "true"`) falls back to its default on its own and logs one warning, so
// a bad row can never 500 the settings routes, the webhook check, or delivery routing.
const imessageFields = {
  enabled: [z.boolean(), false],
  serverUrl: [z.string(), ''],
  passwordEnc: [z.string().nullable(), null],
  allowedHandles: [z.array(z.string()), []],
  defaultHandle: [z.string().nullable(), null],
  defaultChatGuid: [z.string().nullable(), null]
} as const
const emailFields = {
  enabled: [z.boolean(), false],
  to: [z.string().nullable(), null]
} as const
const presenceSchema = z.number().int().min(PRESENCE_MIN).max(PRESENCE_MAX)

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A stored webhook token is usable when it is a non-empty string. */
export function isValidStoredToken(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function parseFields(
  raw: unknown, fields: Record<string, readonly [z.ZodType, unknown]>, where: string, bad: string[]
): Record<string, unknown> {
  const obj = raw === undefined ? {} : raw
  if (!isRecord(obj)) bad.push(`${where} (not an object)`)
  const src = isRecord(obj) ? obj : {}
  const out: Record<string, unknown> = {}
  for (const [k, [schema, dflt]] of Object.entries(fields)) {
    if (!(k in src) || src[k] === undefined) { out[k] = Array.isArray(dflt) ? [] : dflt; continue }
    const r = schema.safeParse(src[k])
    if (r.success) out[k] = r.data
    else { out[k] = Array.isArray(dflt) ? [] : dflt; bad.push(`${where}.${k}`) }
  }
  return out
}

/**
 * Parse the three stored values into a config. Never throws: malformed fields fall back to
 * their defaults (one console.warn per parse). When the iMessage row has no usable webhook
 * token a fresh one is generated here; persisting it is the caller's job (`loadChannelsConfig`).
 */
export function parseChannelsConfig(raw: { imessage?: unknown, email?: unknown, presenceAwayMinutes?: unknown }): ChannelsConfig {
  const bad: string[] = []
  const im = parseFields(raw.imessage, imessageFields, KEY_IMESSAGE, bad) as Omit<IMessageConfig, 'webhookToken'>
  const email = parseFields(raw.email, emailFields, KEY_EMAIL, bad) as unknown as EmailChannelConfig
  const rawToken = isRecord(raw.imessage) ? raw.imessage.webhookToken : undefined
  if (rawToken !== undefined && !isValidStoredToken(rawToken)) bad.push(`${KEY_IMESSAGE}.webhookToken`)
  let presenceAwayMinutes = PRESENCE_DEFAULT
  if (raw.presenceAwayMinutes !== undefined) {
    const r = presenceSchema.safeParse(raw.presenceAwayMinutes)
    if (r.success) presenceAwayMinutes = r.data
    else bad.push(KEY_PRESENCE)
  }
  if (bad.length) console.warn(`[channels] malformed channel settings, using defaults for: ${bad.join(', ')}`)
  return {
    imessage: { ...im, webhookToken: isValidStoredToken(rawToken) ? rawToken : newWebhookToken() },
    email,
    presenceAwayMinutes
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
    serverUrl: z.union([z.literal(''), z.url({ protocol: /^https?$/ }).trim()]),
    password: PasswordField,
    allowedHandles: z.array(z.string()),
    defaultHandle: z.string().nullable()
  }),
  email: z.object({
    enabled: z.boolean(),
    to: z.union([z.literal(''), z.email().trim()]).nullable()
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

// SQL: true when the EXISTING channel_imessage row already holds a usable webhook token.
const STORED_TOKEN_VALID = sql`(coalesce(jsonb_typeof("settings"."value"->'webhookToken') = 'string' and "settings"."value"->>'webhookToken' <> '', false))`

/**
 * Write the iMessage row but never replace a usable stored webhook token: only rotation
 * (`rotateWebhookToken`) changes it. Done in one statement so a PUT that loaded before a
 * concurrent regenerate cannot write the old token back.
 */
async function upsertIMessageKeepingToken(im: IMessageConfig): Promise<void> {
  const now = new Date()
  await useDb().insert(settings)
    .values({ key: KEY_IMESSAGE, value: im, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: sql`excluded.value || (case when ${STORED_TOKEN_VALID} then jsonb_build_object('webhookToken', "settings"."value"->'webhookToken') else '{}'::jsonb end)`,
        updatedAt: now
      }
    })
}

async function readRows(): Promise<Map<string, unknown>> {
  const rows = await useDb().select().from(settings)
    .where(inArray(settings.key, [KEY_IMESSAGE, KEY_EMAIL, KEY_PRESENCE]))
  return new Map(rows.map(r => [r.key, r.value]))
}

// Note: a cold load can WRITE (first-time token generation / repair of a bad token). It is
// idempotent after that first write, so read paths like isAway() calling it are safe.
export async function loadChannelsConfig(): Promise<ChannelsConfig> {
  if (cache) return cache
  let byKey = await readRows()
  let c = parseChannelsConfig({ imessage: byKey.get(KEY_IMESSAGE), email: byKey.get(KEY_EMAIL), presenceAwayMinutes: byKey.get(KEY_PRESENCE) })
  const rawIm = byKey.get(KEY_IMESSAGE)
  if (!isRecord(rawIm) || !isValidStoredToken(rawIm.webhookToken)) {
    // First load, or a row without a usable token: persist the generated token (the rest of the
    // row is written normalised). If another process got there first its token wins — re-read.
    await upsertIMessageKeepingToken(c.imessage)
    byKey = await readRows()
    const stored = byKey.get(KEY_IMESSAGE)
    if (isRecord(stored) && isValidStoredToken(stored.webhookToken)) c = { ...c, imessage: { ...c.imessage, webhookToken: stored.webhookToken } }
  }
  cache = c
  return c
}

/**
 * Persist all three keys. The webhook token in `c` is ignored when a usable one is already
 * stored (see upsertIMessageKeepingToken); rotate it with `rotateWebhookToken`.
 */
export async function saveChannelsConfig(c: ChannelsConfig): Promise<void> {
  const validated = parseChannelsConfig({ imessage: c.imessage, email: c.email, presenceAwayMinutes: c.presenceAwayMinutes })
  await upsertIMessageKeepingToken(validated.imessage)
  await upsert(KEY_EMAIL, validated.email)
  await upsert(KEY_PRESENCE, validated.presenceAwayMinutes)
  cache = null // the stored token may differ from c's; the next load reads the truth
}

/** Replace the webhook token with a fresh one; the old token stops verifying immediately. */
export async function rotateWebhookToken(): Promise<string> {
  await loadChannelsConfig() // ensures the row exists and is an object with a token
  const token = newWebhookToken()
  await useDb().update(settings)
    .set({ value: sql`jsonb_set("settings"."value", '{webhookToken}', to_jsonb(${token}::text))`, updatedAt: new Date() })
    .where(eq(settings.key, KEY_IMESSAGE))
  cache = null
  return token
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
