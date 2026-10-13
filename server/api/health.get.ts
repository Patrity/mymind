import { sql } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'

// Liveness + DB-readiness probe for the CD health check. Public (see PUBLIC_PREFIXES in
// middleware/auth.ts) and DB-touching ON PURPOSE: a plain /login returns 200 via SSR even when
// the DB is unreachable, which masked the B3.1 NUXT_DATABASE_URL incident (the app dialed the
// build-baked @db host and every authed API 500'd while the deploy went green). `select 1`
// exercises the same runtimeConfig DB URL the app actually uses, so a broken DB fails the deploy.
//
// Cycle 86: `sha` is the commit of the running release (MYMIND_GIT_SHA, exported by the Mac mini's
// run.sh from the release's release.env; null elsewhere). CD's web gate requires it to equal the sha it
// just deployed, so a 200 from the OUTGOING process during its shutdown window can't pass the gate.
export default defineEventHandler(async () => {
  await useDb().execute(sql`select 1`)
  return { ok: true, sha: process.env.MYMIND_GIT_SHA || null }
})
