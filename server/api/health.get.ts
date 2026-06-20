import { sql } from 'drizzle-orm'
import { useDb } from '../db'

// Liveness + DB-readiness probe for the CD health check. Public (see PUBLIC_PREFIXES in
// middleware/auth.ts) and DB-touching ON PURPOSE: a plain /login returns 200 via SSR even when
// the DB is unreachable, which masked the B3.1 NUXT_DATABASE_URL incident (the app dialed the
// build-baked @db host and every authed API 500'd while the deploy went green). `select 1`
// exercises the same runtimeConfig DB URL the app actually uses, so a broken DB fails the deploy.
export default defineEventHandler(async () => {
  await useDb().execute(sql`select 1`)
  return { ok: true }
})
