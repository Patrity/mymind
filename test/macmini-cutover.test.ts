// Cycle 86 final wave: the cutover helpers — deploy/macmini/compare-counts.sh (I1: table-by-table row
// counts, old DB vs .80) against a fake psql, and deploy/macmini/copy-uploads.sh (M1: tar over ssh from
// the Proxmox host) with both "remote" sides as local dirs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const COMPARE = resolve('deploy/macmini/compare-counts.sh')
const COPY = resolve('deploy/macmini/copy-uploads.sh')

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mm-cutover-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('compare-counts.sh', () => {
  /** A psql that answers from <dir>/<dsn>.rows (or fails for an unknown DSN, echoing it like psql). */
  function fakePsql() {
    const p = join(dir, 'psql')
    writeFileSync(p, `#!/bin/bash
f="$FAKE_DIR/$1.rows"
[ -f "$f" ] || { echo "psql: error: connection to server at \\"$1\\" failed" >&2; exit 2; }
case "\${@: -1}" in *"count(*)"*"information_schema.tables"*"BASE TABLE"*) cat "$f" ;; *) exit 3 ;; esac
`, { mode: 0o755 })
    return p
  }
  const run = (src: string, dst: string, rows: Record<string, string>) => {
    for (const [dsn, body] of Object.entries(rows)) writeFileSync(join(dir, `${dsn}.rows`), body)
    const r = spawnSync('bash', [COMPARE, src, dst], { env: { ...process.env, MYMIND_PSQL: fakePsql(), FAKE_DIR: dir }, encoding: 'utf8' })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const SAME = 'public.messages|265000\npublic.memories|4100\ndrizzle.__drizzle_migrations|89\npublic.messages_archive|7\n'

  it('exits 0 when every table matches', () => {
    const r = run('old', 'new', { old: SAME, new: SAME.split('\n').reverse().join('\n') })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('4 tables, every row count matches')
  })

  it('prints each mismatch and each one-sided table, exits 1', () => {
    const r = run('old', 'new', {
      old: SAME,
      new: 'public.messages|264999\npublic.memories|4100\ndrizzle.__drizzle_migrations|89\npublic.extra|1\n'
    })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/\[MISMATCH\] public\.messages\s+source=265000 target=264999/)
    expect(r.out).toMatch(/\[MISMATCH\] public\.messages_archive\s+source=7 target=MISSING/)
    expect(r.out).toMatch(/\[MISMATCH\] public\.extra\s+source=MISSING target=1/)
    expect(r.out).not.toMatch(/MISMATCH\] public\.memories/)
    expect(r.out).toContain('3 of 5 tables differ')
  })

  it('a table name that prefixes another never confuses the join', () => {
    const rows = 'public.message|1\npublic.message_parts|2\npublic.messages|3\n'
    expect(run('old', 'new', { old: rows, new: rows }).code).toBe(0)
  })

  it('an unreachable side fails (exit 2) without printing the DSN', () => {
    const r = run('old', 'postgres://bridget:hunter2@192.168.2.80/bridget', { old: SAME })
    expect(r.code).toBe(2)
    expect(r.out).toContain('could not read row counts from the target database')
    expect(r.out).not.toContain('hunter2')
  })

  it('an empty source is an error, not a pass', () => {
    expect(run('old', 'new', { old: '', new: '' }).code).toBe(2)
  })
})

describe('copy-uploads.sh', () => {
  const run = (src: string, dst: string) => {
    const r = spawnSync('bash', [COPY], { env: { ...process.env, LXC_EXEC: '', MINI_SSH: 'bash -c', SRC_DIR: src, DST_DIR: dst }, encoding: 'utf8' })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }

  it('copies the tree and proves the same files and bytes on both sides', () => {
    const src = join(dir, 'lxc-uploads'); const dst = join(dir, 'mini', 'data', 'uploads')
    mkdirSync(join(src, 'ab/cd'), { recursive: true })
    writeFileSync(join(src, 'ab/cd/photo one.jpg'), Buffer.alloc(70_000, 7))
    writeFileSync(join(src, 'note.txt'), 'hello')
    const r = run(src, dst)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('ok: 2 files, 70005 bytes on both sides')
  })

  it('fails when the destination ends up different (a stray file on the mini)', () => {
    const src = join(dir, 'lxc-uploads'); const dst = join(dir, 'mini-uploads')
    mkdirSync(src); writeFileSync(join(src, 'a.bin'), 'aaaa')
    mkdirSync(dst); writeFileSync(join(dst, 'stray.bin'), 'zz')
    const r = run(src, dst)
    expect(r.code).toBe(1)
    expect(r.out).toContain('MISMATCH')
    expect(r.out).toContain('stray.bin')
  })
})
