import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'
import { coreConfig } from '../config'

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
  const pool = new Pool({ connectionString: databaseUrl, max: 10 })
  pool.on('error', onPoolError)
  _db = drizzle(pool, { schema })
  return _db
}
