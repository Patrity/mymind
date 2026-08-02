// test/documents-content-hash.db.test.ts
//
// `pnpm test:db` runs plain vitest with no Nuxt runtime, so this file has to supply what Nuxt
// normally provides at boot: load `.env` for DATABASE_URL and stub the `useRuntimeConfig`
// auto-import that `useDb()` depends on (server/db/index.ts) — same stub pattern already used
// in test/transcribe-clean.test.ts, but pointed at the real local DB since this test is
// asserting real Postgres behaviour, not mocking it away.
process.loadEnvFile('.env')
import { describe, it, expect, vi } from 'vitest'
import { sql } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { useDb } from '../server/db'

const SHA = (t: string) => sql`encode(sha256(convert_to(${t}, 'UTF8')), 'hex')`

// drizzle-orm/node-postgres's db.execute() returns a pg `Result`, not a plain array — unwrap
// `.rows` (the brief's inline test used a driver where execute() returns the array directly).
const rows = <T>(r: unknown) => (r as { rows: T[] }).rows

describe('documents.content_hash is database-generated', () => {
  it('stays correct even when a writer bypasses updateDoc entirely', async () => {
    const db = useDb()
    const [row] = rows<{ id: string, content_hash: string }>(await db.execute(sql`
      insert into documents (path, content) values ('/input/hash-probe.md', 'original body')
      returning id, content_hash
    `))

    expect(row!.content_hash).toBe(
      rows<{ h: string }>(await db.execute(sql`select ${SHA('original body')} as h`))[0]!.h
    )

    // A raw UPDATE that "forgets" the hash — exactly what image-enrich.ts does.
    await db.execute(sql`update documents set content = 'rewritten by a raw update' where id = ${row!.id}`)

    const [after] = rows<{ matches: boolean }>(await db.execute(sql`
      select content_hash = ${SHA('rewritten by a raw update')} as matches from documents where id = ${row!.id}
    `))
    expect(after!.matches).toBe(true)

    await db.execute(sql`delete from documents where id = ${row!.id}`)
  })

  it('refuses a direct write to the generated column', async () => {
    const db = useDb()
    await expect(db.execute(sql`
      insert into documents (path, content, content_hash) values ('/input/x.md', 'a', 'deadbeef')
    `)).rejects.toThrow()
  })
})
