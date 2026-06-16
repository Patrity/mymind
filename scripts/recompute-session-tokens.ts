// Idempotent backfill: recompute per-session input/output token totals with the
// corrected formula. input = input_tokens + cache_creation_input_tokens; cache_read
// is EXCLUDED (it's the cached prefix re-read each turn — already counted once via
// cache_creation, so summing it N-counts the same context). output unchanged.
//
// Run: node_modules/.bin/tsx --env-file=.env scripts/recompute-session-tokens.ts
// Against prod: DATABASE_URL=<prod-url> node_modules/.bin/tsx scripts/recompute-session-tokens.ts
import { Client } from 'pg'

if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL')
const db = new Client({ connectionString: process.env.DATABASE_URL })
await db.connect()

const res = await db.query(`
  update sessions s set
    input_tokens = (select coalesce(sum(
        coalesce((usage->>'input_tokens')::int,0)
      + coalesce((usage->>'cache_creation_input_tokens')::int,0) ),0)::int
      from messages where session_id = s.id),
    output_tokens = (select coalesce(sum( coalesce((usage->>'output_tokens')::int,0) ),0)::int
      from messages where session_id = s.id)
`)
console.log(`recomputed token totals for ${res.rowCount} sessions`)
await db.end()
