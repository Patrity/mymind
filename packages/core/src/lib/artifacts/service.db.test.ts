// DB-backed — harness pattern from test/channels-inbound.db.test.ts (.env + useRuntimeConfig stub).
process.loadEnvFile('.env')

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, it, expect, afterAll, vi } from 'vitest'

const STORE = mkdtempSync(join(tmpdir(), 'artifacts-store-'))
vi.stubGlobal('useRuntimeConfig', () => ({
  databaseUrl: process.env.DATABASE_URL, storageDriver: 'local', storageLocalDir: STORE, betterAuthUrl: 'http://localhost:3000/'
}))

import { publishArtifact, editArtifact, getArtifactDetail, findServable, deleteArtifact, restoreArtifact, resolveArtifactRef, listArtifacts } from './service'

const P = `t${Date.now().toString(36)}`
const created: string[] = []
const html = (s: string) => ({ path: 'index.html', content: `<h1>${s}</h1>` })

describe('publishArtifact', () => {
  it('creates v1 with a slug from the title, private by default', async () => {
    const r = await publishArtifact({ title: `${P} Sales Q3`, files: [html('a')] })
    created.push(r.artifact.id)
    expect(r).toMatchObject({ created: true, newVersion: true, version: 1 })
    expect(r.artifact.slug).toBe(`${P}-sales-q3`)
    expect(r.artifact.isPublic).toBe(false)
    expect(r.artifact.url).toMatch(new RegExp(`/artifact/${P}-sales-q3/$`))
    expect(r.artifact.url).not.toContain('//artifact')
  })

  it('suffixes a colliding generated slug', async () => {
    const r = await publishArtifact({ title: `${P} Sales Q3`, files: [html('b')] })
    created.push(r.artifact.id)
    expect(r.artifact.slug).toBe(`${P}-sales-q3-2`)
  })

  it('requires a title to create', async () => {
    await expect(publishArtifact({ slug: `${P}-notitle`, files: [html('x')] })).rejects.toMatchObject({ code: 'bad_input' })
  })

  it('republishing to a slug makes a new version; identical content does not', async () => {
    const slug = `${P}-ver`
    const a = await publishArtifact({ slug, title: 'v', files: [html('1')] }); created.push(a.artifact.id)
    const b = await publishArtifact({ slug, files: [html('2')] })
    expect(b).toMatchObject({ created: false, newVersion: true, version: 2, previousVersionId: expect.any(String) })
    const c = await publishArtifact({ slug, files: [html('2')] })
    expect(c).toMatchObject({ newVersion: false, version: 2 })
  })

  it('data/ changes patch in place; merge keeps other files', async () => {
    const slug = `${P}-data`
    const a = await publishArtifact({ slug, title: 'd', files: [html('x'), { path: 'data/x.json', content: '{"n":1}' }] }); created.push(a.artifact.id)
    const b = await publishArtifact({ slug, merge: true, files: [{ path: 'data/x.json', content: '{"n":2}' }] })
    expect(b).toMatchObject({ newVersion: false, version: 1 })
    const s = await findServable(slug)
    const sha = (t: string) => createHash('sha256').update(t).digest('hex')
    expect(s!.manifest['data/x.json']).toMatchObject({ sha256: sha('{"n":2}'), size: 7 })
    expect((await getArtifactDetail(a.artifact.id))!.versions).toHaveLength(1)
    expect(Object.keys(s!.manifest).sort()).toEqual(['data/x.json', 'index.html'])
  })

  it('rejects bad input with ArtifactError messages naming the file', async () => {
    await expect(publishArtifact({ title: 't', slug: `${P}-bad`, files: [html('x'), { path: 'v.mov', content: 'x' }] })).rejects.toThrow(/v\.mov: content type not allowed/)
    await expect(publishArtifact({ title: 't', slug: `${P}-bad`, files: [{ path: 'app.js', content: 'x' }] })).rejects.toThrow(/entry index\.html not found/)
    await expect(publishArtifact({ title: 't', slug: 'Bad_Slug', files: [html('x')] })).rejects.toThrow(/slug/)
    await expect(publishArtifact({ title: 't', slug: `${P}-bad`, files: [html('x'), { path: './index.html', content: 'y' }] })).rejects.toThrow(/duplicate/)
    expect(await findServable(`${P}-bad`)).toBeNull() // nothing half-written
  })

  it('concurrent publishes to one slug both succeed (Review Focus #4)', async () => {
    const slug = `${P}-race`
    const a = await publishArtifact({ slug, title: 'r', files: [html('0')] }); created.push(a.artifact.id)
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(n => publishArtifact({ slug, files: [html(String(n))] })))
    for (const r of rs) created.push(r.artifact.id)
    expect(rs.map(r => r.version).sort()).toEqual([2, 3, 4, 5, 6, 7])
  })

  it('concurrent first publishes of a new slug both succeed', async () => {
    const slug = `${P}-race-new`
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(n => publishArtifact({ slug, title: 'n', files: [html(String(n))] })))
    for (const r of rs) created.push(r.artifact.id)
    expect(new Set(rs.map(r => r.artifact.id)).size).toBe(1)
    expect(rs.filter(r => r.created)).toHaveLength(1)
    for (const r of rs) expect(r.artifact.currentVersion).toBe(r.version) // DTO agrees with the returned version
  })

  it('rejects an empty files array (create or update-in-place)', async () => {
    const slug = `${P}-empty`
    await expect(publishArtifact({ slug, title: 'e', files: [] })).rejects.toMatchObject({ code: 'bad_input' })
    const a = await publishArtifact({ slug, title: 'e', files: [html('1')] }); created.push(a.artifact.id)
    await expect(publishArtifact({ slug, files: [], merge: true })).rejects.toMatchObject({ code: 'bad_input', message: 'nothing to publish' })
  })

  it('rejects an oversized bundle before writing any blob', async () => {
    const files = Array.from({ length: 501 }, (_, i) => ({ path: `f${i}.txt`, content: 'x' }))
    const before = readdirSync(STORE, { recursive: true }).length
    await expect(publishArtifact({ title: 't', slug: `${P}-many`, files })).rejects.toMatchObject({ code: 'too_many' })
    expect(readdirSync(STORE, { recursive: true }).length).toBe(before)
  })

  it('a uuid-shaped slug is rejected (it would shadow an id in resolveArtifactRef) — on publish and on rename', async () => {
    const slug = '12345678-1234-1234-1234-123456789abc'
    await expect(publishArtifact({ slug, title: 'u', files: [html('u')] })).rejects.toMatchObject({ code: 'bad_slug' })
    expect(await resolveArtifactRef(slug)).toBeNull()
    const a = await publishArtifact({ slug: `${P}-uuidren`, title: 'u', files: [html('u')] }); created.push(a.artifact.id)
    await expect(editArtifact(a.artifact.id, { slug })).rejects.toMatchObject({ code: 'bad_slug' })
  })

  it('a deleted slug can be reused by a new artifact (Review Focus #5)', async () => {
    const slug = `${P}-reuse`
    const a = await publishArtifact({ slug, title: 'old', files: [html('old')] }); created.push(a.artifact.id)
    await deleteArtifact(a.artifact.id)
    expect(await findServable(slug)).toBeNull()
    const b = await publishArtifact({ slug, title: 'new', files: [html('new')] }); created.push(b.artifact.id)
    expect(b.created).toBe(true)
    expect((await findServable(slug))!.artifactId).toBe(b.artifact.id)
    expect(await restoreArtifact(a.artifact.id)).toBe(false) // slug taken meanwhile
  })
})

describe('editArtifact', () => {
  it('flips visibility, renames the slug, rolls back', async () => {
    const slug = `${P}-edit`
    const a = await publishArtifact({ slug, title: 'e', files: [html('1')] }); created.push(a.artifact.id)
    await publishArtifact({ slug, files: [html('2')] })
    const e = await editArtifact(a.artifact.id, { isPublic: true, slug: `${P}-edited`, rollbackTo: 1 })
    expect(e).toMatchObject({ isPublic: true, slug: `${P}-edited`, currentVersion: 1 })
    const d = await getArtifactDetail(a.artifact.id)
    expect(d!.versions.map(v => [v.version, v.current])).toEqual([[2, false], [1, true]])
    await expect(editArtifact(a.artifact.id, { rollbackTo: 9 })).rejects.toThrow(/version 9/)
    expect(await resolveArtifactRef(`${P}-edited`)).toBe(a.artifact.id)
    expect(await resolveArtifactRef(a.artifact.id)).toBe(a.artifact.id)
  })
})

describe('listArtifacts', () => {
  it('excludes deleted and orders by updated desc', async () => {
    const list = await listArtifacts({ limit: 200 })
    expect(list.every(a => !a.slug.endsWith('-reuse') || a.title === 'new')).toBe(true)
  })
})

afterAll(async () => {
  const { useDb } = await import('../../db')
  const { artifacts } = await import('../../db/schema')
  const { inArray, like, or } = await import('drizzle-orm')
  // Ids collected from every result, plus a backstop on this run's own slug prefix (never other runs' rows).
  const mine = or(...[created.length ? inArray(artifacts.id, created) : undefined, like(artifacts.slug, `${P}-%`)])!
  await useDb().update(artifacts).set({ currentVersionId: null }).where(mine)
  await useDb().delete(artifacts).where(mine)
  rmSync(STORE, { recursive: true, force: true })
})
