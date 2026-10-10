import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema'
import { coreConfig } from '@mymind/core/config'

let _db: ReturnType<typeof drizzle> | null = null

export function useDb() {
  if (_db) return _db
  const { databaseUrl } = coreConfig()
  const pool = new Pool({ connectionString: databaseUrl, max: 10 })
  _db = drizzle(pool, { schema })
  return _db
}
