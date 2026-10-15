// Cycle 86 (spec §4): artifacts service — DB + storage writes, versioning, in-place data updates.
import { Readable } from 'node:stream'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { useDb } from '../../db'
import { artifacts, artifactVersions, type Artifact, type ArtifactVersion } from '../../db/schema/artifacts'
import { storage } from '../../utils/storage'
import { publishChange } from '../../utils/live-bus'
import { coreConfig } from '../../config'
import type { ArtifactDTO, ArtifactDetailDTO, ArtifactVersionDTO } from '../../shared/types/artifacts'
import {
  ARTIFACT_MAX_FILES, ARTIFACT_MAX_FILE_BYTES, ARTIFACT_MAX_TOTAL_BYTES, ArtifactError, contentTypeFor, normalizeArtifactPath, slugFromTitle, slugProblem,
  type Manifest
} from './limits'
import { manifestStats, mergeManifest, onlyDataChanged, validateManifest } from './manifest'

export interface PublishInput {
  slug?: string
  title?: string
  description?: string | null
  files: Array<{ path: string; content: Buffer | string }>
  entry?: string
  spaFallback?: boolean
  isPublic?: boolean
  projectId?: string | null
  conversationId?: string | null
  merge?: boolean
}
export interface PublishResult { artifact: ArtifactDTO; version: number; created: boolean; newVersion: boolean; previousVersionId: string | null }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function artifactUrl(slug: string): string {
  const base = (coreConfig().betterAuthUrl ?? '').replace(/\/+$/, '')
  return `${base}/artifact/${slug}/`
}

function toDTO(row: Artifact, version: ArtifactVersion | null, versionCount: number): ArtifactDTO {
  const stats = version ? manifestStats(version.manifest) : { files: 0, totalBytes: 0 }
  return {
    id: row.id, slug: row.slug, title: row.title, description: row.description, isPublic: row.isPublic,
    projectId: row.projectId, conversationId: row.conversationId,
    currentVersion: version?.version ?? null, versionCount,
    fileCount: stats.files, totalBytes: stats.totalBytes,
    url: artifactUrl(row.slug), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString()
  }
}

function pgCode(e: unknown): string | undefined {
  const x = e as { code?: string; cause?: { code?: string } } | null
  return x?.code ?? x?.cause?.code
}
const isUniqueViolation = (e: unknown) => pgCode(e) === '23505'
const violatedIndex = (e: unknown): string | undefined => {
  const x = e as { constraint?: string; constraint_name?: string; cause?: { constraint?: string; constraint_name?: string } } | null
  return x?.constraint ?? x?.constraint_name ?? x?.cause?.constraint ?? x?.cause?.constraint_name
}

type Tx = Parameters<Parameters<ReturnType<typeof useDb>['transaction']>[0]>[0]

async function uniqueSlug(tx: Tx, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base.slice(0, 64 - String(n).length - 1).replace(/-+$/, '')}-${n}`
    const [hit] = await tx.select({ id: artifacts.id }).from(artifacts)
      .where(and(eq(artifacts.slug, candidate), isNull(artifacts.deletedAt))).limit(1)
    if (!hit) return candidate
  }
}

async function loadDTO(tx: Tx, id: string): Promise<ArtifactDTO> {
  const [row] = await tx.select().from(artifacts).where(eq(artifacts.id, id))
  const [cur] = row!.currentVersionId ? await tx.select().from(artifactVersions).where(eq(artifactVersions.id, row!.currentVersionId)) : []
  const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(artifactVersions).where(eq(artifactVersions.artifactId, id))
  return toDTO(row!, cur ?? null, n)
}

async function prepareBlobs(files: PublishInput['files']): Promise<Manifest> {
  const seen = new Set<string>()
  const prepared: Array<{ path: string; buf: Buffer; contentType: string }> = []
  for (const f of files) {
    const path = normalizeArtifactPath(f.path)
    if (seen.has(path)) throw new ArtifactError(`${path}: duplicate path`, 'bad_path')
    seen.add(path)
    const contentType = contentTypeFor(path)
    if (!contentType) throw new ArtifactError(`${path}: content type not allowed`, 'bad_type')
    const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8')
    if (buf.length > ARTIFACT_MAX_FILE_BYTES) throw new ArtifactError(`${path}: ${buf.length} bytes exceeds the 10 MB per-file limit`, 'too_large')
    prepared.push({ path, buf, contentType })
  }
  // Cheap limit pre-check so an oversized publish writes nothing (merge mode is re-validated after merging).
  if (prepared.length > ARTIFACT_MAX_FILES) throw new ArtifactError(`bundle has ${prepared.length} files; the limit is ${ARTIFACT_MAX_FILES}`, 'too_many')
  const sum = prepared.reduce((n, p) => n + p.buf.length, 0)
  if (sum > ARTIFACT_MAX_TOTAL_BYTES) throw new ArtifactError(`bundle is ${sum} bytes; the limit is 25 MB`, 'too_large')
  // Blobs go to storage BEFORE the DB transaction so the row lock is never held across I/O.
  const next: Manifest = {}
  for (const p of prepared) {
    const put = await storage().put(Readable.from(p.buf), { contentType: p.contentType })
    next[p.path] = { key: put.key, sha256: put.sha256, size: put.size, contentType: p.contentType }
  }
  return next
}

const sameManifest = (a: Manifest, b: Manifest) => {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every(p => Object.hasOwn(b, p) && a[p]!.sha256 === b[p]!.sha256)
}

export async function publishArtifact(input: PublishInput): Promise<PublishResult> {
  if (input.slug !== undefined) {
    const problem = slugProblem(input.slug)
    if (problem) throw new ArtifactError(problem, 'bad_slug')
  }
  const next = await prepareBlobs(input.files)

  const run = async (tx: Tx) => {
    const live = input.slug
      ? (await tx.select().from(artifacts).where(and(eq(artifacts.slug, input.slug), isNull(artifacts.deletedAt))).for('update'))[0]
      : undefined

    if (!live) {
      if (!input.title) throw new ArtifactError('title is required to create an artifact', 'bad_input')
      const entry = input.entry ?? 'index.html'
      validateManifest(next, entry)
      const slug = input.slug ?? await uniqueSlug(tx, slugFromTitle(input.title))
      const [art] = await tx.insert(artifacts).values({
        slug, title: input.title, description: input.description ?? null, isPublic: input.isPublic ?? false,
        projectId: input.projectId ?? null, conversationId: input.conversationId ?? null
      }).returning()
      const [ver] = await tx.insert(artifactVersions).values({
        artifactId: art!.id, version: 1, manifest: next, entry, spaFallback: input.spaFallback ?? false,
        totalBytes: manifestStats(next).totalBytes
      }).returning()
      await tx.update(artifacts).set({ currentVersionId: ver!.id }).where(eq(artifacts.id, art!.id))
      return { id: art!.id, version: 1, created: true, newVersion: true, previousVersionId: null as string | null }
    }

    const [cur] = live.currentVersionId ? await tx.select().from(artifactVersions).where(eq(artifactVersions.id, live.currentVersionId)) : []
    const entry = input.entry ?? cur?.entry ?? 'index.html'
    const spaFallback = input.spaFallback ?? cur?.spaFallback ?? false
    const merged = mergeManifest(cur?.manifest ?? null, next, input.merge ?? false)
    validateManifest(merged, entry)

    const meta: Partial<typeof artifacts.$inferInsert> = { updatedAt: new Date() }
    if (input.title !== undefined) meta.title = input.title
    if (input.description !== undefined) meta.description = input.description
    if (input.isPublic !== undefined) meta.isPublic = input.isPublic
    if (input.projectId !== undefined) meta.projectId = input.projectId
    if (input.conversationId !== undefined) meta.conversationId = input.conversationId

    const settings = cur && cur.entry === entry && cur.spaFallback === spaFallback
    if (cur && settings && onlyDataChanged(cur.manifest, merged)) {
      await tx.update(artifactVersions).set({ manifest: merged, totalBytes: manifestStats(merged).totalBytes }).where(eq(artifactVersions.id, cur.id))
      await tx.update(artifacts).set(meta).where(eq(artifacts.id, live.id))
      return { id: live.id, version: cur.version, created: false, newVersion: false, previousVersionId: null }
    }
    if (cur && settings && sameManifest(cur.manifest, merged)) {
      await tx.update(artifacts).set(meta).where(eq(artifacts.id, live.id))
      return { id: live.id, version: cur.version, created: false, newVersion: false, previousVersionId: null }
    }
    const [{ max } = { max: 0 }] = await tx.select({ max: sql<number>`coalesce(max(${artifactVersions.version}), 0)::int` })
      .from(artifactVersions).where(eq(artifactVersions.artifactId, live.id))
    const version = max + 1
    const [ver] = await tx.insert(artifactVersions).values({
      artifactId: live.id, version, manifest: merged, entry, spaFallback, totalBytes: manifestStats(merged).totalBytes
    }).returning()
    await tx.update(artifacts).set({ ...meta, currentVersionId: ver!.id }).where(eq(artifacts.id, live.id))
    return { id: live.id, version, created: false, newVersion: true, previousVersionId: live.currentVersionId }
  }
  // The DTO is loaded inside the same transaction so artifact.currentVersion always agrees with `version`.
  const attempt = () => useDb().transaction(async (tx) => {
    const res = await run(tx)
    return { ...res, artifact: await loadDTO(tx, res.id) }
  })

  let r: Awaited<ReturnType<typeof attempt>> | undefined
  for (let i = 1; !r; i++) {
    try { r = await attempt() } catch (e) {
      // Concurrent first-publishes of one brand-new slug: the loser hits the live-slug unique index;
      // retry (bounded) so it takes the update path against the winner's row.
      if (i >= 3 || !isUniqueViolation(e) || violatedIndex(e) !== 'artifacts_slug_live_uidx') throw e
    }
  }
  publishChange({ resource: 'artifact', action: r.created ? 'created' : 'updated', id: r.id })
  return { artifact: r.artifact, version: r.version, created: r.created, newVersion: r.newVersion, previousVersionId: r.previousVersionId }
}

export async function editArtifact(id: string, patch: {
  title?: string; description?: string | null; slug?: string; isPublic?: boolean; projectId?: string | null; rollbackTo?: number
}): Promise<ArtifactDTO | null> {
  if (patch.slug !== undefined) {
    const problem = slugProblem(patch.slug)
    if (problem) throw new ArtifactError(problem, 'bad_slug')
  }
  let dto: ArtifactDTO | null
  try {
    dto = await useDb().transaction(async (tx) => {
      const [row] = await tx.select().from(artifacts).where(and(eq(artifacts.id, id), isNull(artifacts.deletedAt))).for('update')
      if (!row) return null
      const set: Partial<typeof artifacts.$inferInsert> = { updatedAt: new Date() }
      if (patch.title !== undefined) set.title = patch.title
      if (patch.description !== undefined) set.description = patch.description
      if (patch.slug !== undefined) set.slug = patch.slug
      if (patch.isPublic !== undefined) set.isPublic = patch.isPublic
      if (patch.projectId !== undefined) set.projectId = patch.projectId
      if (patch.rollbackTo !== undefined) {
        const [v] = await tx.select({ id: artifactVersions.id }).from(artifactVersions)
          .where(and(eq(artifactVersions.artifactId, id), eq(artifactVersions.version, patch.rollbackTo)))
        if (!v) throw new ArtifactError(`version ${patch.rollbackTo} not found`, 'not_found')
        set.currentVersionId = v.id
      }
      await tx.update(artifacts).set(set).where(eq(artifacts.id, id))
      return loadDTO(tx, id)
    })
  } catch (e) {
    if (isUniqueViolation(e)) throw new ArtifactError(`slug ${patch.slug} is already in use`, 'bad_slug')
    throw e
  }
  if (dto) publishChange({ resource: 'artifact', action: 'updated', id })
  return dto
}

export async function setCurrentVersion(id: string, versionId: string | null): Promise<void> {
  await useDb().update(artifacts).set({ currentVersionId: versionId, updatedAt: new Date() }).where(eq(artifacts.id, id))
  publishChange({ resource: 'artifact', action: 'updated', id })
}

export async function listArtifacts(o: { projectId?: string; limit?: number } = {}): Promise<ArtifactDTO[]> {
  const db = useDb()
  const where = o.projectId ? and(isNull(artifacts.deletedAt), eq(artifacts.projectId, o.projectId)) : isNull(artifacts.deletedAt)
  const rows = await db.select().from(artifacts).where(where).orderBy(desc(artifacts.updatedAt)).limit(o.limit ?? 50)
  if (!rows.length) return []
  const ids = rows.map(r => r.id)
  const vids = rows.map(r => r.currentVersionId).filter((v): v is string => !!v)
  const versions = vids.length ? await db.select().from(artifactVersions).where(inArray(artifactVersions.id, vids)) : []
  const counts = await db.select({ id: artifactVersions.artifactId, n: sql<number>`count(*)::int` }).from(artifactVersions)
    .where(inArray(artifactVersions.artifactId, ids)).groupBy(artifactVersions.artifactId)
  const vById = new Map(versions.map(v => [v.id, v]))
  const nById = new Map(counts.map(c => [c.id, c.n]))
  return rows.map(r => toDTO(r, r.currentVersionId ? vById.get(r.currentVersionId) ?? null : null, nById.get(r.id) ?? 0))
}

export async function getArtifactDetail(id: string): Promise<ArtifactDetailDTO | null> {
  const db = useDb()
  const [row] = await db.select().from(artifacts).where(and(eq(artifacts.id, id), isNull(artifacts.deletedAt)))
  if (!row) return null
  const vers = await db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, id)).orderBy(desc(artifactVersions.version))
  const cur = vers.find(v => v.id === row.currentVersionId) ?? null
  const versions: ArtifactVersionDTO[] = vers.map(v => ({
    id: v.id, version: v.version, entry: v.entry, fileCount: Object.keys(v.manifest).length, totalBytes: v.totalBytes,
    createdAt: v.createdAt.toISOString(), current: v.id === row.currentVersionId
  }))
  return { ...toDTO(row, cur, vers.length), versions }
}

export async function findServable(slug: string) {
  const db = useDb()
  const [row] = await db.select({
    artifactId: artifacts.id, slug: artifacts.slug, isPublic: artifacts.isPublic,
    manifest: artifactVersions.manifest, entry: artifactVersions.entry, spaFallback: artifactVersions.spaFallback
  }).from(artifacts).innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(and(eq(artifacts.slug, slug), isNull(artifacts.deletedAt)))
  return row ?? null
}

export async function resolveArtifactRef(ref: string): Promise<string | null> {
  const db = useDb()
  if (UUID_RE.test(ref)) {
    const [byId] = await db.select({ id: artifacts.id }).from(artifacts).where(and(eq(artifacts.id, ref), isNull(artifacts.deletedAt)))
    if (byId) return byId.id
  }
  const [row] = await db.select({ id: artifacts.id }).from(artifacts).where(and(eq(artifacts.slug, ref), isNull(artifacts.deletedAt)))
  return row?.id ?? null
}

export async function deleteArtifact(id: string): Promise<boolean> {
  const rows = await useDb().update(artifacts).set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(artifacts.id, id), isNull(artifacts.deletedAt))).returning({ id: artifacts.id })
  if (!rows.length) return false
  publishChange({ resource: 'artifact', action: 'deleted', id })
  return true
}

export async function restoreArtifact(id: string): Promise<boolean> {
  let rows: Array<{ id: string }>
  try {
    rows = await useDb().update(artifacts).set({ deletedAt: null, updatedAt: new Date() })
      .where(and(eq(artifacts.id, id), sql`${artifacts.deletedAt} is not null`)).returning({ id: artifacts.id })
  } catch (e) {
    if (isUniqueViolation(e)) return false // the slug was reused while it was deleted
    throw e
  }
  if (!rows.length) return false
  publishChange({ resource: 'artifact', action: 'created', id })
  return true
}
