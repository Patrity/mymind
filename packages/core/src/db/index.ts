import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'
import { coreConfig } from '../config'
import { currentEvalScope } from '../lib/eval/context'

/**
 * Cycle 85 (spec §3.2): the app's ONE pool, routed per call chain. Inside an eval scope every
 * query and every transaction checkout goes to that world's tenant pool (search_path = its own
 * schema, then public), so eval rows physically live outside `public` and no normal read path can
 * see them. Routing is decided at query time, not at `useDb()` time, so a drizzle handle captured
 * outside a scope (better-auth's adapter, a module-level `const db = useDb()`) still routes
 * correctly when it runs inside one, and vice versa.
 *
 * drizzle's node-postgres driver detects a pool by `instanceof Pool` (transactions check out a
 * client), which a subclass keeps.
 */
export class RoutingPool extends Pool {
  override query(...args: unknown[]): never {
    const scope = currentEvalScope()
    const target = scope ? scope.pool : null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (target ? (target.query as any)(...args) : (super.query as any)(...args)) as never
  }

  override connect(...args: unknown[]): never {
    const scope = currentEvalScope()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (scope ? (scope.pool.connect as any).apply(scope.pool, args) : (super.connect as any).apply(this, args)) as never
  }
}

let _db: ReturnType<typeof drizzle> | null = null

/**
 * An idle pooled client whose socket dies (Postgres restart, container recreate, idle-connection
 * kill) makes the Pool emit 'error'. With no listener that is an uncaught EventEmitter error and
 * kills the process — the worker has no Nitro trap around it (final review I1). The pool already
 * discards the dead client and opens a fresh one on the next query, so logging is all we need.
 */
export function onPoolError(err: Error): void {
  console.error('[db] idle pool client error (client discarded, pool continues):', err.message)
}

export function useDb() {
  if (_db) return _db
  const { databaseUrl } = coreConfig()
  const pool = new RoutingPool({ connectionString: databaseUrl, max: 10 })
  pool.on('error', onPoolError)
  _db = drizzle(pool, { schema })
  return _db
}
