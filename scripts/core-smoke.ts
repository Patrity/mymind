// Cycle 80 plain-Node smoke: proves @mymind/core runs outside Nuxt/Nitro (the step-2 worker's
// situation). Imports ONLY @mymind/core + npm packages, initialises core from process.env, and
// runs two READ-ONLY queries against the database (the dev DB is shared — never write here).
//
//   node_modules/.bin/tsx --env-file=.env scripts/core-smoke.ts   → prints `core-smoke OK …`
import { count, sql } from 'drizzle-orm'
import { initCore, type CoreConfig } from '@mymind/core/config'
import { useDb } from '@mymind/core/db'
import { projects } from '@mymind/core/db/schema'

// Only the DB is exercised, so only databaseUrl is filled; the rest stay unset like in
// scripts/lib/core-init.ts.
initCore({ databaseUrl: process.env.DATABASE_URL } as CoreConfig)

const db = useDb()
const one = await db.execute(sql`select 1 as one`)
const [row] = await db.select({ n: count() }).from(projects)
const first = one.rows[0]?.one
if (first !== 1) throw new Error(`select 1 returned ${JSON.stringify(one)}`)
console.log(`core-smoke OK select1=${first} projects=${row?.n}`)
process.exit(0)
