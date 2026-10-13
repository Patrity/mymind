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
import { syncBuiltinESMExports } from 'node:module'
import type { Pool } from 'pg'
import type { Connection } from '../google/connections'
import type { BlueBubblesClient } from '../channels/bluebubbles/client'
import type { SearchResponse } from '../search/types'
import { currentEvalScope, runInEvalScope, EvalNetworkBlockedError, type CapturedWrite, type EvalScope, type EvalWebPage } from './context'
import { createFakeGoogle } from './fake-google'
import { parseEvalSetup, type EvalSetup } from './setup'
import { createEvalTenant, dropEvalRunTenants, dropEvalTenant, type EvalTenant } from './tenant'

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

function urlOfHttpArgs(protocol: string, args: unknown[]): string {
  const a = args[0]
  if (typeof a === 'string') return a
  if (a instanceof URL) return a.toString()
  const o = (a ?? {}) as { protocol?: string; hostname?: string; host?: string; port?: number | string; path?: string }
  return `${o.protocol ?? protocol}//${o.hostname ?? o.host ?? 'localhost'}${o.port ? `:${o.port}` : ''}${o.path ?? '/'}`
}

function blocked(scope: EvalScope, url: string): EvalNetworkBlockedError {
  scope.onBlockedNetwork(url)
  return new EvalNetworkBlockedError(url)
}

/**
 * Wraps `globalThis.fetch` and `http(s).request/get` ONCE per process. Outside an eval scope they
 * behave exactly as before; inside one, a request the world does not allow throws (fetch rejects)
 * before anything is sent. Idempotent.
 */
export function installNetworkGuard(): void {
  if (guardInstalled) return
  guardInstalled = true
  const transport = globalThis.fetch
  globalThis.fetch = (function evalGuardedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const scope = currentEvalScope()
    if (scope) {
      const url = urlOfFetchInput(input)
      if (!scope.allowNetwork(url)) return Promise.reject(blocked(scope, url))
    }
    return transport(input, init)
  }) as typeof fetch
  for (const [mod, protocol] of [[http, 'http:'], [https, 'https:']] as const) {
    for (const fn of ['request', 'get'] as const) {
      const original = mod[fn] as (...a: unknown[]) => unknown
      ;(mod as unknown as Record<string, unknown>)[fn] = function evalGuardedRequest(this: unknown, ...args: unknown[]) {
        const scope = currentEvalScope()
        if (scope) {
          const url = urlOfHttpArgs(protocol, args)
          if (!scope.allowNetwork(url)) throw blocked(scope, url)
        }
        return original.apply(this, args)
      }
    }
  }
  // ESM `import { request } from 'node:https'` bindings follow the patched CJS exports.
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
  /** Runs `fn` inside the world. */
  run<T>(fn: () => T | Promise<T>): Promise<T>
  /** Ends the pool and drops the tenant. Idempotent. */
  dispose(): Promise<void>
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
  const capture = (kind: string, detail: Record<string, unknown>) => {
    if (captured.length >= MAX_CAPTURED) return
    captured.push({ kind, at: Date.now(), detail: JSON.parse(JSON.stringify(detail)) as Record<string, unknown> })
  }
  const account = evalAccount(setup, schema)
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
    onBlockedNetwork: (url) => { blockedNetwork.push(url) }
  }
  let disposed: Promise<void> | null = null
  return {
    runId, schema, setup, account, captured, activity, suppressed, blockedNetwork,
    run: fn => runInEvalScope(scope, async () => fn()),
    dispose: () => disposed ??= (async () => {
      scope.active = false
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
  const leftover = await dropEvalRunTenants(runId)
  return { dropped: live.length + leftover }
}
