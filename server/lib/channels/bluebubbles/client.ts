// server/lib/channels/bluebubbles/client.ts
// Thin REST client for a BlueBubbles server (v1 API). Every request carries `?password=` (URL-
// encoded via URLSearchParams) and a 15 s timeout. Chat GUIDs contain `;` and `+`, so they are
// always URL-encoded in paths. Errors surface as BlueBubblesError with a `retryable` verdict:
// 5xx / 408 / 429 / network / timeout → retryable, other 4xx → not.
//
// The one special case is a timed-out AppleScript send: AppleScript sends routinely take longer
// than the HTTP timeout yet still go out, so that is reported as `unconfirmed` (the delivery
// worker later confirms it via findOwnMessage) rather than as a retryable failure that would
// double-text. With the Private API a timeout is a plain retryable error.
import type { Tapback } from '../types'
import { normaliseHandle } from '../handles'
import { loadChannelsConfig, blueBubblesPassword } from '../config'

export interface BlueBubblesClient {
  serverInfo(): Promise<{ privateApi: boolean; serverVersion: string; detectedIcloud: string | null }>
  sendText(chatGuid: string, text: string, tempGuid: string): Promise<{ guid: string | null; unconfirmed: boolean }>
  sendAttachment(chatGuid: string, file: { name: string; mime: string; data: Buffer }, tempGuid: string): Promise<{ guid: string | null; unconfirmed: boolean }>
  react(chatGuid: string, messageGuid: string, tapback: Tapback): Promise<void>
  typing(chatGuid: string, on: boolean): Promise<void>
  markRead(chatGuid: string): Promise<void>
  /** Raw message objects created after `afterMs`, oldest first. */
  messagesSince(afterMs: number, limit?: number): Promise<unknown[]>
  /** Guid of an isFromMe message in the chat with exactly this text, created at/after `sinceMs`. */
  findOwnMessage(chatGuid: string, text: string, sinceMs: number): Promise<string | null>
  /** Downloads with BlueBubbles' conversion (original=false), so HEIC arrives as JPEG. */
  downloadAttachment(guid: string): Promise<{ data: Buffer; mime: string; name: string }>
  /** Chat GUID of the direct (1:1) iMessage chat with a handle. Deterministic, no request. */
  resolveDirectChat(handle: string): Promise<string>
}

export class BlueBubblesError extends Error {
  constructor(msg: string, public retryable: boolean, public status?: number) {
    super(msg)
    this.name = 'BlueBubblesError'
  }
}

/** The request timed out (the server may still have acted on it). */
export class BlueBubblesTimeoutError extends BlueBubblesError {
  constructor(msg: string) {
    super(msg, true)
    this.name = 'BlueBubblesTimeoutError'
  }
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_QUERY_LIMIT = 100
const OWN_MESSAGE_SCAN_LIMIT = 50

type Envelope = { status?: number; message?: string; data?: unknown; error?: { message?: string } }

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
}

/** 5xx, 408 (request timeout) and 429 (rate limited) are worth retrying; other 4xx are not. */
function retryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? v as Record<string, unknown> : {}
}

export function blueBubblesClient(cfg: {
  serverUrl: string
  password: string
  fetchImpl?: typeof fetch
  /** Send method: true → 'private-api', false → 'apple-script'. Omitted → detected once via serverInfo. */
  privateApi?: boolean
  /** Per-request timeout; tests shorten it. */
  timeoutMs?: number
}): BlueBubblesClient {
  const base = cfg.serverUrl.replace(/\/+$/, '')
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let privateApi: Promise<boolean> | null = cfg.privateApi === undefined ? null : Promise.resolve(cfg.privateApi)

  async function request(method: string, path: string, init: { json?: unknown; form?: FormData; query?: Record<string, string> } = {}): Promise<Response> {
    const u = new URL(base + path)
    for (const [k, v] of Object.entries(init.query ?? {})) u.searchParams.set(k, v)
    u.searchParams.set('password', cfg.password)
    const doFetch = cfg.fetchImpl ?? globalThis.fetch
    let res: Response
    try {
      res = await doFetch(u, {
        method,
        headers: init.json !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: init.json !== undefined ? JSON.stringify(init.json) : init.form,
        signal: AbortSignal.timeout(timeoutMs)
      })
    }
    catch (e) {
      if (isTimeout(e)) throw new BlueBubblesTimeoutError(`BlueBubbles ${method} ${path} timed out after ${timeoutMs} ms`)
      throw new BlueBubblesError(`BlueBubbles ${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`, true)
    }
    if (!res.ok) {
      let detail = ''
      try {
        const env = await res.json() as Envelope
        detail = env.error?.message ?? env.message ?? ''
      }
      catch { /* non-JSON error body */ }
      throw new BlueBubblesError(`BlueBubbles ${method} ${path} → ${res.status}${detail ? `: ${detail}` : ''}`, retryableStatus(res.status), res.status)
    }
    return res
  }

  async function data(method: string, path: string, init?: Parameters<typeof request>[2]): Promise<unknown> {
    const res = await request(method, path, init)
    try {
      return ((await res.json()) as Envelope).data
    }
    catch (e) {
      if (isTimeout(e)) throw new BlueBubblesTimeoutError(`BlueBubbles ${method} ${path} timed out reading the response`)
      throw new BlueBubblesError(`BlueBubbles ${method} ${path} returned a malformed body`, true, res.status)
    }
  }

  const chatPath = (chatGuid: string, rest: string) => `/api/v1/chat/${encodeURIComponent(chatGuid)}/${rest}`

  async function serverInfo() {
    const d = rec(await data('GET', '/api/v1/server/info'))
    return {
      privateApi: d.private_api === true,
      serverVersion: typeof d.server_version === 'string' ? d.server_version : '',
      detectedIcloud: typeof d.detected_icloud === 'string' && d.detected_icloud ? d.detected_icloud : null
    }
  }

  function usesPrivateApi(): Promise<boolean> {
    if (!privateApi) {
      const p = serverInfo().then(i => i.privateApi)
      privateApi = p
      p.catch(() => { if (privateApi === p) privateApi = null }) // retry detection next time
    }
    return privateApi
  }

  // A send: an AppleScript timeout means "probably sent, unconfirmed"; everything else throws.
  async function send(path: string, pa: boolean, init: Parameters<typeof request>[2]): Promise<{ guid: string | null; unconfirmed: boolean }> {
    try {
      const d = rec(await data('POST', path, init))
      return { guid: typeof d.guid === 'string' ? d.guid : null, unconfirmed: false }
    }
    catch (e) {
      if (e instanceof BlueBubblesTimeoutError && !pa) return { guid: null, unconfirmed: true }
      throw e
    }
  }

  return {
    serverInfo,

    async sendText(chatGuid, text, tempGuid) {
      const pa = await usesPrivateApi()
      return send('/api/v1/message/text', pa, {
        json: { chatGuid, tempGuid, message: text, method: pa ? 'private-api' : 'apple-script' }
      })
    },

    async sendAttachment(chatGuid, file, tempGuid) {
      const pa = await usesPrivateApi()
      const form = new FormData()
      form.append('chatGuid', chatGuid)
      form.append('tempGuid', tempGuid)
      form.append('name', file.name)
      form.append('attachment', new Blob([file.data as BlobPart], { type: file.mime }), file.name)
      form.append('method', pa ? 'private-api' : 'apple-script')
      return send('/api/v1/message/attachment', pa, { form })
    },

    async react(chatGuid, messageGuid, tapback) {
      await request('POST', '/api/v1/message/react', { json: { chatGuid, selectedMessageGuid: messageGuid, reaction: tapback } })
    },

    async typing(chatGuid, on) {
      await request(on ? 'POST' : 'DELETE', chatPath(chatGuid, 'typing'))
    },

    async markRead(chatGuid) {
      await request('POST', chatPath(chatGuid, 'read'))
    },

    async messagesSince(afterMs, limit = DEFAULT_QUERY_LIMIT) {
      const d = await data('POST', '/api/v1/message/query', {
        json: { with: ['chat', 'attachment', 'handle'], after: afterMs, sort: 'ASC', limit }
      })
      return Array.isArray(d) ? d : []
    },

    async findOwnMessage(chatGuid, text, sinceMs) {
      // BlueBubbles serves a chat's messages as GET with query params (newest first).
      const d = await data('GET', chatPath(chatGuid, 'message'), {
        query: { after: String(sinceMs), sort: 'DESC', limit: String(OWN_MESSAGE_SCAN_LIMIT) }
      })
      for (const m of Array.isArray(d) ? d : []) {
        const r = rec(m)
        if (r.isFromMe === true && r.text === text && typeof r.dateCreated === 'number' && r.dateCreated >= sinceMs && typeof r.guid === 'string') {
          return r.guid
        }
      }
      return null
    },

    async downloadAttachment(guid) {
      const path = `/api/v1/attachment/${encodeURIComponent(guid)}`
      const meta = rec(await data('GET', path))
      const res = await request('GET', `${path}/download`, { query: { original: 'false' } })
      let bytes: ArrayBuffer
      try { bytes = await res.arrayBuffer() }
      catch (e) {
        if (isTimeout(e)) throw new BlueBubblesTimeoutError(`BlueBubbles attachment ${guid} download timed out`)
        throw new BlueBubblesError(`BlueBubbles attachment ${guid} download failed`, true)
      }
      return {
        data: Buffer.from(bytes),
        mime: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim(),
        name: typeof meta.transferName === 'string' && meta.transferName ? meta.transferName : guid
      }
    },

    async resolveDirectChat(handle) {
      return `iMessage;-;${normaliseHandle(handle)}`
    }
  }
}

/** The fake server's password — BLUEBUBBLES_FAKE_URL always pairs with it. */
export const FAKE_BLUEBUBBLES_PASSWORD = 'fake'

// One client per (server URL, password): each client detects the Private API once via
// serverInfo, so reusing it keeps that request off every send. A config change makes a new key.
let cached: { key: string; client: BlueBubblesClient } | null = null
function clientFor(serverUrl: string, password: string): BlueBubblesClient {
  const key = `${serverUrl}\n${password}`
  if (cached?.key !== key) cached = { key, client: blueBubblesClient({ serverUrl, password }) }
  return cached.client
}

/**
 * A client for the configured BlueBubbles server, or null when iMessage is disabled or lacks a
 * server URL / password. BLUEBUBBLES_FAKE_URL (dev + tests) overrides the config entirely: the
 * client points at that fake with password `fake`, so no real text can leave. Under vitest
 * (VITEST set) without a fake URL it is always null — the dev DB is shared and may hold a real
 * server's config, so no test can ever reach it.
 */
export async function imessageClient(): Promise<BlueBubblesClient | null> {
  const fakeUrl = process.env.BLUEBUBBLES_FAKE_URL
  if (fakeUrl) return clientFor(fakeUrl, FAKE_BLUEBUBBLES_PASSWORD)
  if (process.env.VITEST) return null
  const c = (await loadChannelsConfig()).imessage
  if (!c.enabled || !c.serverUrl) return null
  const password = blueBubblesPassword(c)
  if (!password) return null
  return clientFor(c.serverUrl, password)
}
