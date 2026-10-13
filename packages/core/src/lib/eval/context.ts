// Cycle 85 (spec §3.2): the eval scope — which eval world, if any, the current async call chain
// runs in. Every seam that could reach real life (the DB pool, live events, activity rows, Google,
// the web, embeddings, iMessage, the outbox, raw network) asks `currentEvalScope()` and, inside a
// scope, uses the world's fakes / tenant instead.
//
// AsyncLocalStorage, NOT a process switch: Tony's real runs share the worker process with eval
// runs, so a global "eval mode" flag would fake his Gmail mid-turn. A scope only reaches code
// called (or async work started) from inside `runInEvalScope`.
//
// A scope keeps answering after its world is disposed: a timer or late callback an eval attempt
// left behind must never fall back to a REAL resource (Tony's pool, his tabs). Its DB work fails
// at the ended tenant pool instead; its captures land in a world nobody reads.
//
// This module imports nothing at runtime from the rest of core (db/index.ts depends on it).
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Pool } from 'pg'
import type { Connection } from '../google/connections'
import type { SearchResponse } from '../search/types'
import type { BlueBubblesClient } from '../channels/bluebubbles/client'

/** A write the fake world absorbed instead of performing (gmail send, calendar insert, a queued
 *  iMessage, …). `detail` is JSON-safe. */
export interface CapturedWrite {
  kind: string
  at: number
  detail: Record<string, unknown>
}

export interface EvalWebPage {
  status: number
  /** Response body (HTML or plain text). */
  body: string
}

export interface EvalScope {
  runId: string
  /** The tenant schema this world's rows live in (also its bus namespace). */
  worldId: string
  /** Pool whose connections run with `search_path = <worldId>, public`. */
  pool: Pool
  busNs: string
  /** False once the world is disposed (informational — the scope still isolates). */
  active: boolean
  capture(kind: string, detail: Record<string, unknown>): void
  /** A live change / activity event that would have reached Tony's open tabs. */
  suppressLive(kind: 'change' | 'activity', event: unknown): void
  /** An activity_log row that would have reached the global recorder buffer. */
  recordActivity(row: unknown): void
  googleFetch: typeof fetch
  googleConnections(): Connection[]
  webSearch(query: string, opts?: { count?: number }): Promise<SearchResponse>
  webFetch(url: string): Promise<EvalWebPage>
  embed(texts: string[]): Promise<number[][]>
  imessage: BlueBubblesClient
  /** Whether an outbound request to `url` may leave the process (default: none may). */
  allowNetwork(url: string): boolean
  /** A blocked outbound request (the guard threw). */
  onBlockedNetwork(url: string): void
}

const als = new AsyncLocalStorage<EvalScope>()

/** The eval scope this call chain runs in (disposed or not), or null (Tony's real work). */
export function currentEvalScope(): EvalScope | null {
  return als.getStore() ?? null
}

export function runInEvalScope<T>(scope: EvalScope, fn: () => T): T {
  return als.run(scope, fn)
}

/** Run `fn` OUTSIDE any eval scope — for process-lifetime resources (the LISTEN connection) that
 *  may be created lazily from inside an eval call chain and must not inherit it. */
export function outsideEvalScope<T>(fn: () => T): T {
  return als.exit(fn)
}

/** Thrown by the network guard for an outbound request inside an eval scope. */
export class EvalNetworkBlockedError extends Error {
  constructor(public url: string) {
    super(`eval: outbound network blocked (${url})`)
    this.name = 'EvalNetworkBlockedError'
  }
}
