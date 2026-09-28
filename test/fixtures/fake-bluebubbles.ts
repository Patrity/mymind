// test/fixtures/fake-bluebubbles.ts
// An in-process fake of the BlueBubbles v1 REST API — the ONLY BlueBubbles server tests and dev
// checks may talk to (no real texts during the build). Implements just the routes the client in
// server/lib/channels/bluebubbles/client.ts uses, records every call, and enforces `?password=`.
//
// Standalone:  pnpm fake:bluebubbles   (node test/fixtures/fake-bluebubbles.ts --port 4455)
// then run the app with BLUEBUBBLES_FAKE_URL=http://127.0.0.1:4455 (password is always `fake`).
//
// Kept free of app imports and TS-only syntax (no enums / parameter properties) so Node's
// built-in type stripping can run it directly.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'

export interface FakeSent {
  kind: 'text' | 'attachment'
  chatGuid: string
  tempGuid: string
  method: string
  message?: string
  name?: string
  mime?: string
  size?: number
  guid: string
}

export interface FakeBlueBubbles {
  url: string
  password: string
  sent: FakeSent[]
  reactions: unknown[]
  typing: { chatGuid: string; on: boolean }[]
  reads: string[]
  /** Bodies of every POST /message/query, in order. */
  queries: unknown[]
  /** Raw message objects served by /message/query and /chat/:guid/message. */
  messages: FakeMessage[]
  pushMessage(m: unknown): void
  /** Flip what /server/info reports for the Private API. */
  setPrivateApi(on: boolean): void
  /** Make /server/info answer 503 (a BlueBubbles outage) until set back. */
  setDown(down: boolean): void
  close(): Promise<void>
}

type FakeMessage = Record<string, unknown> & { guid?: string; dateCreated?: number; chats?: { guid?: string }[] }

// 1×1 transparent PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

function reply(res: ServerResponse, status: number, data: unknown, message = 'Success'): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ status, message, data }))
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

function chatOf(m: FakeMessage): string | undefined {
  return Array.isArray(m.chats) ? m.chats[0]?.guid : undefined
}

export async function startFakeBlueBubbles(opts: {
  privateApi?: boolean
  /** The first n sends (text or attachment) answer 503. */
  failSends?: number
  /** /message/text records the send (and the own message) but never answers. */
  sendHangs?: boolean
  password?: string
  port?: number
  /** Log each request (method + path, never the password) — standalone mode. */
  verbose?: boolean
  /** Image downloads come back as `image/heic` even with original=false (a failed conversion). */
  heicAttachments?: boolean
  /** Per-attachment-guid download type/name (default: a PNG named photo.png). */
  attachmentTypes?: Record<string, { mime: string; name: string }>
} = {}): Promise<FakeBlueBubbles> {
  const password = opts.password ?? 'fake'
  let privateApi = opts.privateApi ?? false
  let down = false
  let failSends = opts.failSends ?? 0
  let seq = 0
  const sent: FakeSent[] = []
  const reactions: unknown[] = []
  const typing: { chatGuid: string; on: boolean }[] = []
  const reads: string[] = []
  const queries: unknown[] = []
  const messages: FakeMessage[] = []

  // Mirrors what the real server would now hold: Bridget's own message in that chat.
  function recordOwn(chatGuid: string, text: string): string {
    const guid = `fake-msg-${++seq}`
    messages.push({ guid, text, isFromMe: true, dateCreated: Date.now(), chats: [{ guid: chatGuid }], attachments: [] })
    return guid
  }

  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (u.searchParams.get('password') !== password) return reply(res, 401, null, 'Unauthorized')
      const path = u.pathname
      const method = req.method ?? 'GET'
      if (opts.verbose) console.log(`[fake-bluebubbles] ${method} ${path}`)
      const body = method === 'POST' || method === 'PUT' ? await readBody(req) : Buffer.alloc(0)
      const json = (): Record<string, unknown> => (body.length ? JSON.parse(body.toString('utf8')) : {})

      if (method === 'GET' && path === '/api/v1/server/info') {
        if (down) return reply(res, 503, null, 'Service Unavailable')
        return reply(res, 200, { private_api: privateApi, server_version: '1.9.9-fake', detected_icloud: 'fake@icloud.com' })
      }

      if (method === 'POST' && path === '/api/v1/message/text') {
        const b = json()
        if (failSends > 0) { failSends--; return reply(res, 503, null, 'Service Unavailable') }
        const chatGuid = String(b.chatGuid), text = String(b.message)
        const guid = recordOwn(chatGuid, text)
        sent.push({ kind: 'text', chatGuid, tempGuid: String(b.tempGuid), method: String(b.method), message: text, guid })
        if (opts.sendHangs) return // never answer; close() destroys the socket
        return reply(res, 200, { guid, text, isFromMe: true, dateCreated: Date.now() })
      }

      if (method === 'POST' && path === '/api/v1/message/attachment') {
        if (failSends > 0) { failSends--; return reply(res, 503, null, 'Service Unavailable') }
        const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData()
        const file = form.get('attachment')
        const chatGuid = String(form.get('chatGuid'))
        const guid = `fake-msg-${++seq}`
        sent.push({
          kind: 'attachment', chatGuid, tempGuid: String(form.get('tempGuid')), method: String(form.get('method')),
          name: String(form.get('name')), mime: file instanceof Blob ? file.type : '', size: file instanceof Blob ? file.size : 0, guid
        })
        return reply(res, 200, { guid, isFromMe: true, dateCreated: Date.now() })
      }

      if (method === 'POST' && path === '/api/v1/message/react') {
        reactions.push(json())
        return reply(res, 200, {})
      }

      if (method === 'POST' && path === '/api/v1/message/query') {
        const b = json()
        queries.push(b)
        const after = typeof b.after === 'number' ? b.after : 0
        const limit = typeof b.limit === 'number' ? b.limit : 1000
        const out = messages.filter(m => (m.dateCreated ?? 0) > after)
          .sort((a, c) => (a.dateCreated ?? 0) - (c.dateCreated ?? 0))
        return reply(res, 200, b.sort === 'DESC' ? out.reverse().slice(0, limit) : out.slice(0, limit))
      }

      const chat = path.match(/^\/api\/v1\/chat\/([^/]+)\/(typing|read|message)$/)
      if (chat) {
        // Chat GUIDs carry `;` and `+`; the client must URL-encode them in the path.
        if (/[;+]/.test(chat[1]!)) return reply(res, 400, null, 'chat guid must be URL-encoded')
        const chatGuid = decodeURIComponent(chat[1]!)
        if (chat[2] === 'typing' && (method === 'POST' || method === 'DELETE')) {
          typing.push({ chatGuid, on: method === 'POST' })
          return reply(res, 200, {})
        }
        if (chat[2] === 'read' && method === 'POST') {
          reads.push(chatGuid)
          return reply(res, 200, {})
        }
        if (chat[2] === 'message' && method === 'GET') {
          const after = Number(u.searchParams.get('after') ?? 0)
          const limit = Number(u.searchParams.get('limit') ?? 25)
          const out = messages.filter(m => chatOf(m) === chatGuid && (m.dateCreated ?? 0) >= after)
            .sort((a, c) => (c.dateCreated ?? 0) - (a.dateCreated ?? 0))
          return reply(res, 200, out.slice(0, limit))
        }
      }

      const att = path.match(/^\/api\/v1\/attachment\/([^/]+)(\/download)?$/)
      if (att && method === 'GET') {
        const guid = decodeURIComponent(att[1]!)
        const type = opts.attachmentTypes?.[guid] ?? { mime: 'image/png', name: 'photo.png' }
        const mime = opts.heicAttachments && type.mime.startsWith('image/') ? 'image/heic' : type.mime
        if (att[2]) {
          res.writeHead(200, { 'content-type': mime, 'content-length': TINY_PNG.length })
          return res.end(TINY_PNG)
        }
        return reply(res, 200, { guid, transferName: type.name, mimeType: mime })
      }

      return reply(res, 404, null, 'Not Found')
    }
    catch (e) {
      return reply(res, 500, null, e instanceof Error ? e.message : String(e))
    }
  })

  const port = await new Promise<number>(r => server.listen(opts.port ?? 0, '127.0.0.1', () => r((server.address() as { port: number }).port)))
  return {
    url: `http://127.0.0.1:${port}`,
    password,
    sent, reactions, typing, reads, queries, messages,
    pushMessage(m: unknown) { messages.push(m as FakeMessage) },
    setPrivateApi(on: boolean) { privateApi = on },
    setDown(d: boolean) { down = d },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) })
  }
}

// Standalone entry: `node test/fixtures/fake-bluebubbles.ts --port 4455 [--private-api]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--port')
  const port = i >= 0 ? Number(process.argv[i + 1]) : 4455
  const fake = await startFakeBlueBubbles({ port, privateApi: process.argv.includes('--private-api'), verbose: true })
  console.log(`fake BlueBubbles listening on ${fake.url} (password: ${fake.password})`)
  console.log(`run the app with BLUEBUBBLES_FAKE_URL=${fake.url}`)
}
