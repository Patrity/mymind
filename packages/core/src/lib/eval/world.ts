// Cycle 85 (spec §3.2): the EvalWorld — one recorded fake world, installed per eval attempt and
// scoped by AsyncLocalStorage (context.ts), never by a process switch: Tony's real runs in the same
// worker keep his real Gmail, web and DB while an eval runs beside them.
//
// Inside `world.run(fn)`:
//   - MyMind data (tasks, memories, documents, conversations, workstreams, run events, activity…)
//     reads and writes the world's tenant schema (tenant.ts) — invisible to every normal query;
//   - Google (Gmail / Calendar / People) is the fixture server in fake-google.ts — writes captured;
//   - web_search / web_fetch / research_web answer from `setup.web` (unknown URL → 404);
//   - embeddings are local and deterministic; iMessage is a capturing fake; the outbox captures and
//     never sends; live changes and activity events never reach Tony's tabs; activity rows stay in
//     the world (`world.activity`);
//   - and any OTHER outbound request (fetch, http/https) throws EvalNetworkBlockedError unless the
//     installer allowed its URL (Task 3 allows only the model endpoints it needs).
//
// Exported for Task 3: installEvalWorld(runId, setup, options?) and cleanupEvalRun(runId).
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import { syncBuiltinESMExports } from 'node:module'
import type { Pool } from 'pg'
import type { Connection } from '../google/connections'
import type { BlueBubblesClient } from '../channels/bluebubbles/client'
import type { SearchResponse } from '../search/types'
import { currentEvalScope, runInEvalScope, EvalNetworkBlockedError, type CapturedWrite, type EvalScope, type EvalWebPage } from './context'
import { createFakeGoogle } from './fake-google'
import { parseEvalSetup, type EvalSetup } from './setup'
import { createEvalTenant, dropEvalTenant, listEvalTenants, evalRunPrefix, tenantDrift, type EvalTenant } from './tenant'
import { cleanupWorldOutside, dropWorldIfFree, removeRunGhostContainers, sweepEvalLeftovers, type SweepResult } from './cleanup'
import { coreConfig } from '../../config'

export type { CapturedWrite } from './context'

const MAX_CAPTURED = 2_000
const MAX_ACTIVITY = 2_000
const EMBED_DIM = 2560

// ---------------------------------------------------------------------------------------------
// Network guard
// ---------------------------------------------------------------------------------------------

let guardInstalled = false

function urlOfFetchInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

/** The URL Node will really contact: `request(url, options)` takes host/port/path from `options`
 *  over the URL (fix round 1, M4). */
function urlOfHttpArgs(protocol: string, args: unknown[]): string {
  const a = args[0]
  const o = (typeof args[1] === 'object' && args[1] !== null ? args[1] : typeof a === 'object' && a !== null && !(a instanceof URL) ? a : {}) as
    { protocol?: string; hostname?: string; host?: string; port?: number | string; path?: string }
  let base: URL | null = null
  if (typeof a === 'string') { try { base = new URL(a) } catch { base = null } } else if (a instanceof URL) base = a
  const proto = o.protocol ?? base?.protocol ?? protocol
  const host = o.hostname ?? o.host?.replace(/:\d+$/, '') ?? base?.hostname ?? 'localhost'
  const port = o.port ?? (base?.port || '')
  const p = o.path ?? (base ? `${base.pathname}${base.search}` : '/')
  return `${proto}//${host}${port ? `:${port}` : ''}${p}`
}

function hostOfUrl(url: string): string {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, '') } catch { return '' }
}

/** Where a `net.connect` / `tls.connect` / `Socket#connect` call goes — `{ host, port }`, or
 *  `{ path }` for a unix socket — or null for a TLS upgrade of an existing socket (pg's SSL
 *  handshake on a connection already checked). Node's internal calls pass a normalized args array. */
function endpointOfSocketArgs(raw: unknown[], defaultPort?: number): { host: string; port: number | null } | { path: string } | null {
  const args = Array.isArray(raw[0]) ? (raw[0] as unknown[]) : raw
  const a = args[0]
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(a) }
  if (typeof a === 'string') return { path: a }
  const o = (a ?? {}) as { host?: string; port?: number | string; path?: string; socket?: unknown }
  if (o.socket) return null
  if (o.path) return { path: o.path }
  const port = o.port !== undefined && o.port !== '' ? Number(o.port) : (defaultPort ?? null)
  return { host: (o.host ?? 'localhost').replace(/^\[|\]$/g, ''), port }
}

function portOfUrl(url: string): number {
  try { const u = new URL(url); return u.port ? Number(u.port) : u.protocol === 'http:' ? 80 : 443 } catch { return 443 }
}

function blocked(scope: EvalScope, url: string): EvalNetworkBlockedError {
  scope.onBlockedNetwork(url)
  return new EvalNetworkBlockedError(url)
}

/** Allowed outbound URL: the world allows it, and its host is then allowed at the socket level too. */
function allowUrl(scope: EvalScope, url: string): boolean {
  if (!scope.allowNetwork(url)) return false
  scope.permitHost(hostOfUrl(url), portOfUrl(url))
  return true
}

type Fn = (...a: unknown[]) => unknown
function wrap(mod: object, name: string, check: (scope: EvalScope, args: unknown[]) => void): void {
  const original = (mod as Record<string, unknown>)[name] as Fn | undefined
  if (typeof original !== 'function') return
  ;(mod as Record<string, unknown>)[name] = function evalGuarded(this: unknown, ...args: unknown[]) {
    const scope = currentEvalScope()
    if (scope) check(scope, args)
    return original.apply(this, args)
  }
}

/**
 * Wraps, ONCE per process, every way out of it: `globalThis.fetch`, `http(s).request/get`,
 * `net.connect/createConnection`, `tls.connect` and DNS (`dns.lookup/resolve*`, callback and
 * promise APIs). Outside an eval scope they behave exactly as before; inside one, a request the
 * world does not allow throws (fetch / dns.promises reject, a dns callback gets the error) before
 * anything is sent. Socket and DNS level: only the database host (the tenant pool) and hosts of
 * URLs the world allowed. Idempotent.
 */
export function installNetworkGuard(): void {
  if (guardInstalled) return
  guardInstalled = true
  const transport = globalThis.fetch
  globalThis.fetch = (function evalGuardedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const scope = currentEvalScope()
    if (scope) {
      const url = urlOfFetchInput(input)
      if (!allowUrl(scope, url)) return Promise.reject(blocked(scope, url))
    }
    return transport(input, init)
  }) as typeof fetch
  for (const [mod, protocol] of [[http, 'http:'], [https, 'https:']] as const) {
    for (const fn of ['request', 'get']) {
      wrap(mod, fn, (scope, args) => {
        const url = urlOfHttpArgs(protocol, args)
        if (!allowUrl(scope, url)) throw blocked(scope, url)
      })
    }
  }
  const socketCheck = (kind: string, defaultPort?: number) => (scope: EvalScope, args: unknown[]) => {
    const ep = endpointOfSocketArgs(args, defaultPort)
    if (ep === null) return
    if ('path' in ep) { if (!scope.allowSocket(ep.path, null)) throw blocked(scope, `unix://${ep.path}`); return }
    if (!scope.allowSocket(ep.host, ep.port)) throw blocked(scope, `${kind}://${ep.host}${ep.port !== null ? `:${ep.port}` : ''}`)
  }
  wrap(net, 'connect', socketCheck('tcp'))
  wrap(net, 'createConnection', socketCheck('tcp'))
  wrap(tls, 'connect', socketCheck('tls', 443))
  // Fix round 2 (N4): the raw path — `new net.Socket().connect(port, host)` (pg's own) and every
  // socket Node opens internally.
  wrap(net.Socket.prototype, 'connect', socketCheck('tcp'))
  const dnsNames = ['lookup', 'lookupService', 'reverse', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt']
  // Fix round 2 (N4): `new dns.Resolver()` / `new dns.promises.Resolver()` instances too.
  for (const proto of [dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const name of dnsNames) {
      const original = (proto as unknown as Record<string, Fn>)[name]
      if (typeof original !== 'function') continue
      const promised = proto === dns.promises.Resolver.prototype
      ;(proto as unknown as Record<string, unknown>)[name] = function evalGuardedResolver(this: unknown, ...args: unknown[]) {
        const scope = currentEvalScope()
        const host = String(args[0] ?? '')
        if (scope && !scope.allowHost(host)) {
          const err = blocked(scope, `dns://${host}`)
          if (promised) return Promise.reject(err)
          const cb = args.findLast(x => typeof x === 'function') as ((e: Error) => void) | undefined
          if (cb) { process.nextTick(() => cb(err)); return undefined }
          throw err
        }
        return original.apply(this, args)
      }
    }
  }
  for (const name of dnsNames) {
    const original = (dns as unknown as Record<string, Fn>)[name]
    if (typeof original !== 'function') continue
    ;(dns as unknown as Record<string, unknown>)[name] = function evalGuardedDns(this: unknown, ...args: unknown[]) {
      const scope = currentEvalScope()
      const host = String(args[0] ?? '')
      if (scope && !scope.allowHost(host)) {
        const err = blocked(scope, `dns://${host}`)
        const cb = args.findLast(x => typeof x === 'function') as ((e: Error) => void) | undefined
        if (cb) { process.nextTick(() => cb(err)); return undefined }
        throw err
      }
      return original.apply(this, args)
    }
    const p = (dns.promises as unknown as Record<string, Fn>)[name]
    if (typeof p !== 'function') continue
    ;(dns.promises as unknown as Record<string, unknown>)[name] = function evalGuardedDnsPromise(this: unknown, ...args: unknown[]) {
      const scope = currentEvalScope()
      const host = String(args[0] ?? '')
      if (scope && !scope.allowHost(host)) return Promise.reject(blocked(scope, `dns://${host}`))
      return p.apply(this, args)
    }
  }
  // ESM `import { request } from 'node:https'` (etc.) bindings follow the patched CJS exports.
  syncBuiltinESMExports()
}

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

function normalizeUrl(u: string): string {
  try {
    const x = new URL(u)
    x.hash = ''
    let s = x.toString()
    if (s.endsWith('/') && x.pathname !== '/') s = s.slice(0, -1)
    return s
  } catch {
    return u
  }
}

export function fakeWebFetch(setup: EvalSetup): (url: string) => Promise<EvalWebPage> {
  const pages = new Map<string, { status?: number; html?: string; text?: string }>()
  for (const [k, v] of Object.entries(setup.web?.pages ?? {})) pages.set(normalizeUrl(k), v)
  return async (url) => {
    const p = pages.get(normalizeUrl(url))
    if (!p) return { status: 404, body: 'Not Found' }
    return { status: p.status ?? 200, body: p.html ?? p.text ?? '' }
  }
}

export function fakeWebSearch(setup: EvalSetup): (q: string, opts?: { count?: number }) => Promise<SearchResponse> {
  const patterns = Object.entries(setup.web?.search ?? {}).map(([p, results]) => {
    let test: (q: string) => boolean
    try {
      const re = new RegExp(p, 'i')
      test = q => re.test(q)
    } catch {
      test = q => q.toLowerCase().includes(p.toLowerCase())
    }
    return { test, results }
  })
  return async (q, opts) => {
    const hit = patterns.find(p => p.test(q))
    return { results: (hit?.results ?? []).slice(0, opts?.count ?? 10) }
  }
}

/** Deterministic local embedding: hashed bag of words, L2-normalised (texts sharing words land
 *  near each other — enough for a world's handful of memories / passages). */
export async function fakeEmbed(texts: string[]): Promise<number[][]> {
  return texts.map((t) => {
    const v = new Array<number>(EMBED_DIM).fill(0)
    for (const w of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      let h = 0x811c9dc5
      for (let i = 0; i < w.length; i++) { h ^= w.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
      v[h % EMBED_DIM]! += 1
    }
    const n = Math.hypot(...v)
    if (n === 0) { v[0] = 1; return v }
    return v.map(x => x / n)
  })
}

export function fakeImessage(capture: (kind: string, detail: Record<string, unknown>) => void): BlueBubblesClient {
  let n = 0
  return {
    async serverInfo() { return { privateApi: true, serverVersion: 'eval', detectedIcloud: null } },
    async sendText(chatGuid, text) {
      capture('imessage.send', { chatGuid, text })
      return { guid: `eval-imessage-${++n}`, unconfirmed: false }
    },
    async sendAttachment(chatGuid, file) {
      capture('imessage.attachment', { chatGuid, name: file.name, mime: file.mime, bytes: file.data.length })
      return { guid: `eval-imessage-${++n}`, unconfirmed: false }
    },
    async react(chatGuid, messageGuid, tapback) { capture('imessage.react', { chatGuid, messageGuid, tapback }) },
    async typing() {},
    async markRead() {},
    async messagesSince() { return [] },
    async findOwnMessage() { return null },
    async downloadAttachment() { throw new Error('eval: no iMessage attachments in a world') },
    async resolveDirectChat(handle) { return `iMessage;-;${handle}` }
  }
}

// ---------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------

export interface EvalWorldOptions {
  /** Outbound requests that may leave the process (default: none). Task 3 allows the model only. */
  allowNetwork?: (url: string) => boolean
  /** Replaces the local deterministic embedder. */
  embed?: (texts: string[]) => Promise<number[][]>
  /** Clock for Gmail's relative queries (newer_than:). */
  now?: () => number
  /** Fix round 1 (M2): the eval share for judge / subagent model calls (EvalScope.throttle). */
  throttle?: EvalScope['throttle']
}

export interface EvalWorld {
  runId: string
  /** The tenant schema (also the world's bus namespace). */
  schema: string
  setup: EvalSetup
  /** The fixture Google account the tools see. */
  account: Connection
  /** Writes the world absorbed (gmail send / drafts / modify, calendar writes, outbox, iMessage…). */
  captured: CapturedWrite[]
  /** activity_log rows the world kept out of Tony's log (model calls, tool spans, errors). */
  activity: unknown[]
  /** Live changes / activity events kept off Tony's tabs. */
  suppressed: { change: number; activity: number }
  /** Outbound requests the guard refused. */
  blockedNetwork: string[]
  /** Fix round 1 (M3): writes were dropped past the capture cap — the attempt must fail scoring
   *  (a forbidden write may be among the unrecorded ones). */
  readonly truncated: boolean
  /** Fix round 1 (Concern 5): drops `outbox` captures whose row a rolled-back transaction never
   *  committed. Call at the end of an attempt, before scoring (and before dispose). */
  settle(): Promise<void>
  /** Fix round 1 (M1): public tables this world does not shadow (a migration since install) —
   *  non-empty means in-world SQL could fall through to Tony's tables: fail the attempt. */
  drift(): Promise<string[]>
  /** Runs `fn` inside the world. */
  run<T>(fn: () => T | Promise<T>): Promise<T>
  /** Ends the pool and drops the tenant. Idempotent. */
  dispose(): Promise<void>
}

/** The database's endpoint from DATABASE_URL: `{ host, port }`, or the unix socket pg opens for a
 *  `?host=/dir` URL (`<dir>/.s.PGSQL.<port>`). Null when none is configured (unit tests). */
export function databaseEndpoint(): { host: string; port: number } | { path: string } | null {
  try {
    const u = new URL(coreConfig().databaseUrl as string)
    const port = u.port ? Number(u.port) : 5432
    const sockDir = u.searchParams.get('host')
    if (sockDir?.startsWith('/')) return { path: `${sockDir.replace(/\/$/, '')}/.s.PGSQL.${port}` }
    const host = (sockDir || u.hostname).toLowerCase().replace(/^\[|\]$/g, '')
    if (host.startsWith('/')) return { path: `${host.replace(/\/$/, '')}/.s.PGSQL.${port}` }
    return { host: host || 'localhost', port }
  } catch {
    return null
  }
}

export function evalAccount(setup: EvalSetup, schema: string): Connection {
  return {
    id: `eval-google-${schema.slice(-8)}`, accountId: 'eval', userId: 'eval', googleSub: 'eval', provider: 'google',
    label: setup.gmail?.account ?? 'personal', email: setup.gmail?.email ?? 'tony@eval.example', status: 'ok', lastError: null
  }
}

/** The scope + world over an existing pool (installEvalWorld supplies a tenant; unit tests a stub). */
export function buildEvalWorld(args: { runId: string; schema: string; pool: Pool; setup: EvalSetup; options?: EvalWorldOptions; dispose?: () => Promise<void> }): EvalWorld {
  const { runId, schema, pool, setup } = args
  const options = args.options ?? {}
  const captured: CapturedWrite[] = []
  const activity: unknown[] = []
  const blockedNetwork: string[] = []
  const suppressed = { change: 0, activity: 0 }
  let truncated = false
  const capture = (kind: string, detail: Record<string, unknown>) => {
    if (captured.length >= MAX_CAPTURED) { truncated = true; return }
    captured.push({ kind, at: Date.now(), detail: JSON.parse(JSON.stringify(detail)) as Record<string, unknown> })
  }
  const account = evalAccount(setup, schema)
  // Socket / DNS allow-list: the database (the tenant pool connects from inside the world).
  // DNS: host names. Sockets: host:port pairs (fix round 2, N4 — the DB host only on the DB port).
  const hosts = new Set<string>()
  const sockets = new Set<string>()
  const db = databaseEndpoint()
  if (db) {
    if ('path' in db) sockets.add(`unix:${db.path}`)
    else { hosts.add(db.host); sockets.add(`${db.host}:${db.port}`) }
  }
  const google = createFakeGoogle(setup, account.email, capture, options.now)
  const scope: EvalScope = {
    runId, worldId: schema, pool, busNs: schema, active: true,
    capture,
    suppressLive: (kind) => { suppressed[kind]++ },
    recordActivity: (row) => { if (activity.length < MAX_ACTIVITY) activity.push(row) },
    googleFetch: google.fetch,
    googleConnections: () => [account],
    webSearch: fakeWebSearch(setup),
    webFetch: fakeWebFetch(setup),
    embed: options.embed ?? fakeEmbed,
    imessage: fakeImessage(capture),
    allowNetwork: options.allowNetwork ?? (() => false),
    allowHost: host => hosts.has(host.toLowerCase()),
    allowSocket: (host, port) => port === null ? sockets.has(`unix:${host}`) : sockets.has(`${host.toLowerCase()}:${port}`),
    permitHost: (host, port) => { if (host) { hosts.add(host.toLowerCase()); sockets.add(`${host.toLowerCase()}:${port}`) } },
    onBlockedNetwork: (url) => { blockedNetwork.push(url) },
    ...(options.throttle ? { throttle: options.throttle } : {}),
    scriptedApproval: (req) => {
      const a = setup.approve ?? 'none'
      const approved = a === 'all' || (Array.isArray(a) && a.includes(req.tool))
      capture('approval.request', { tool: req.tool, ...(req.title ? { title: req.title } : {}), approved })
      return approved
    }
  }
  let disposed: Promise<void> | null = null
  return {
    runId, schema, setup, account, captured, activity, suppressed, blockedNetwork,
    get truncated() { return truncated },
    settle: async () => {
      const ids = captured.filter(c => c.kind === 'outbox').map(c => String(c.detail.deliveryId ?? ''))
      if (!ids.length) return
      const r = await pool.query<{ id: string }>('select id::text as id from channel_deliveries where id::text = any($1)', [ids])
      const kept = new Set(r.rows.map(x => x.id))
      for (let i = captured.length - 1; i >= 0; i--) {
        const c = captured[i]!
        if (c.kind === 'outbox' && !kept.has(String(c.detail.deliveryId ?? ''))) captured.splice(i, 1)
      }
    },
    drift: () => tenantDrift(schema),
    run: fn => runInEvalScope(scope, async () => fn()),
    dispose: () => disposed ??= (async () => {
      scope.active = false
      // Fix round 2 (N6): the world's watch timers stop before its containers / schema go.
      try { (await import('../sandbox/runtime')).stopEvalWorkspaceRuntime(scope) } catch (err) { console.warn('[eval] stopping the world runtime failed:', (err as Error).message) }
      try { (await import('../sandbox/docker')).unregisterEvalSandbox(schema) } catch { /* never registered */ }
      await args.dispose?.()
    })()
  }
}

const liveWorlds = new Map<string, Set<EvalWorld>>()

/**
 * Installs one world for an eval run: validates `setup`, creates the tenant, seeds its memories and
 * tasks, and returns the world. Call `world.dispose()` after the attempt (or `cleanupEvalRun` for
 * everything of the run). Several worlds of one run may be live at once (one per attempt).
 */
export async function installEvalWorld(runId: string, setupRaw: unknown, options: EvalWorldOptions = {}): Promise<EvalWorld> {
  const setup = parseEvalSetup(setupRaw)
  installNetworkGuard()
  const tenant: EvalTenant = await createEvalTenant(runId)
  let set = liveWorlds.get(runId)
  if (!set) liveWorlds.set(runId, set = new Set())
  const world: EvalWorld = buildEvalWorld({
    runId, schema: tenant.schema, pool: tenant.pool, setup, options,
    dispose: async () => {
      set!.delete(world)
      if (!set!.size) liveWorlds.delete(runId)
      // Containers, workspace dir and uploads first (the upload keys are read from the schema).
      await cleanupWorldOutside(tenant.schema)
      await dropEvalTenant(tenant)
    }
  })
  set.add(world)
  try {
    await world.run(() => seedWorld(setup))
  } catch (err) {
    await world.dispose()
    throw err
  }
  return world
}

async function seedWorld(setup: EvalSetup): Promise<void> {
  if (setup.memories?.length) {
    const { createMemory } = await import('../../services/memory')
    for (const m of setup.memories) {
      await createMemory({ content: m.content, scope: m.scope ?? 'user', project: m.project ?? null, tags: m.tags ?? [], reviewed: true })
    }
  }
  if (setup.documents?.length) {
    const { createDoc } = await import('../../services/documents')
    for (const d of setup.documents) {
      await createDoc({ path: d.path, title: d.title ?? d.path.split('/').pop()!.replace(/\.md$/, ''), content: d.content })
    }
  }
  if (setup.tasks?.length) {
    const { createTask } = await import('../../services/tasks')
    for (const t of setup.tasks) {
      await createTask({ title: t.title, description: t.description, project: t.project ?? null, ...(t.status ? { status: t.status as never } : {}) })
    }
  }
}

/** Disposes every live world of the run in this process and drops any tenant of the run left in
 *  the database (e.g. by a crashed process). Returns the number of schemas dropped. */
export async function cleanupEvalRun(runId: string): Promise<{ dropped: number }> {
  const live = [...(liveWorlds.get(runId) ?? [])]
  for (const w of live) await w.dispose()
  const prefix = evalRunPrefix(runId)
  let dropped = live.length
  // Orphans of the run (a crashed process's) — only under their lock: a world of this run live in
  // ANOTHER process holds its lock and is left alone (fix round 2, N2a / N3).
  for (const schema of (await listEvalTenants()).filter(n => n.startsWith(prefix))) {
    if ((await dropWorldIfFree(schema)).dropped) dropped++
  }
  // Containers of the run whose world schema is already gone (a crash between the two).
  try { await removeRunGhostContainers(runId) } catch (err) { console.warn(`[eval] container cleanup of run ${runId} failed:`, (err as Error).message) }
  return { dropped }
}

/** The tenant schemas of worlds live in this process. */
export function liveWorldSchemas(): Set<string> {
  return new Set([...liveWorlds.values()].flatMap(s => [...s].map(w => w.schema)))
}

/** Worker boot (fix round 1, I2): sweep tenants + containers + dirs of dead / finished / stale
 *  runs, never a world this process holds. Never throws. */
export async function bootSweepEval(): Promise<SweepResult | null> {
  try { return await sweepEvalLeftovers({ keep: liveWorldSchemas() }) } catch (err) {
    console.warn('[eval] boot sweep failed:', (err as Error).message)
    return null
  }
}
