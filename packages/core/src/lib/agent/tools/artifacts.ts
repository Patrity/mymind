// Cycle 86 (spec §6): Bridget's artifact tools — publish a page / built webapp, edit, list, delete.
// Results never throw on a bad request: an ArtifactError (or a workspace read failure) is `{ ok:false, error }`.
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentRuns } from '../../../db/schema/agent-runs'
import { getProject } from '../../../services/projects'
import {
  deleteArtifact, editArtifact, getArtifactDetail, listArtifacts, publishArtifact, resolveArtifactRef, restoreArtifact, setCurrentVersion,
  type PublishInput
} from '../../artifacts/service'
import { readWorkspaceBundle } from '../../artifacts/workspace-bundle'
import { rootAbsoluteRefs } from '../../artifacts/html-warnings'
import { ArtifactError, normalizeArtifactPath } from '../../artifacts/limits'
import { workspaceRuntime } from '../../sandbox/runtime'
import { runNetworkMode } from './workspace'
import { dbWorkspaceStore } from '../../sandbox/store'
import type { AgentTool, ToolContext, ToolExecution } from '../types'

const fail = (error: string, summary = 'artifact: refused'): ToolExecution => ({ result: { ok: false, error }, summary })
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A tool call that makes an artifact public is the one outbound act here (it puts content on the internet). */
const PUBLIC_TARGET_REFUSAL = 'this artifact is public — pass public: true to publish to it (Tony must approve that in this run)'
/** Tainted run + an already-public target + no explicit public flag: writing would put content on the internet
 *  without the outboundWhen gate firing (it only sees args). public:false (making it private) is safe. */
const refusesPublicTarget = (ctx: ToolContext, targetPublic: boolean, arg: unknown) =>
  ctx.isTainted?.() === true && targetPublic && arg !== true && arg !== false

const isPublicCall = (a: Record<string, unknown>) => a.public === true

async function conversationIdFor(runId: string | undefined): Promise<string | null> {
  if (!runId) return null
  const [r] = await useDb().select({ c: agentRuns.conversationId }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
  return r?.c ?? null
}

/** Project slug → id; `undefined` slug → undefined; unknown → throws ArtifactError('bad_input'). */
async function projectIdFor(slug: string | undefined): Promise<string | undefined> {
  if (slug === undefined) return undefined
  const p = await getProject(slug)
  if (!p) throw new ArtifactError(`unknown project "${slug}"`, 'bad_input')
  return p.id
}

function okShape(art: { id: string; slug: string; title: string; url: string; isPublic: boolean }, extra: Record<string, unknown>) {
  return { ok: true, id: art.id, slug: art.slug, title: art.title, url: art.url, isPublic: art.isPublic, ...extra }
}

export const publishArtifactTool: AgentTool = {
  name: 'publish_artifact',
  toolset: 'artifacts',
  kind: 'create',
  outboundWhen: isPublicCall,
  // Headless: a background run may not put content on the internet unattended — that call is proposed.
  proposeWhen: isPublicCall,
  description: 'Publish a web page or built webapp as an artifact Tony can open at https://brain.costanzoclan.com/artifact/<slug>/ (also shown in chat). Use it whenever a chart, dashboard, demo or visual preview conveys something better than text. Pass `html` for a single self-contained page, or build in your workspace first (`pnpm build`; for Vite set `base: \'./\'`) and pass `workspace_path` = the output dir (e.g. `dist`). Use relative asset paths. Pages run sandboxed: no localStorage/cookies, no MyMind API; CDN scripts are fine. Put refreshable data in `data/*.json`, fetch it relatively, and refresh it later with `files` + `merge: true` (updates in place, no new version). Republishing to the same slug makes a new version. Private unless `public: true`.',
  schema: {
    title: z.string().min(1).max(200).optional().describe('Required when creating'),
    slug: z.string().optional().describe('URL slug; omit to derive from the title, or pass an existing slug to republish'),
    description: z.string().max(1000).optional(),
    html: z.string().optional().describe('A single self-contained HTML page'),
    files: z.record(z.string(), z.string()).optional().describe('Map of relative path → text content'),
    workspace_path: z.string().optional().describe('Workspace directory to publish (e.g. dist)'),
    entry: z.string().optional().describe('Entry file, default index.html'),
    spa_fallback: z.boolean().optional().describe('Serve the entry for unknown paths (single-page apps)'),
    public: z.boolean().optional().describe('Make the artifact reachable without login'),
    project: z.string().optional().describe('Project slug'),
    merge: z.boolean().optional().describe('Merge `files` into the current version; data-only changes update in place'),
    workspaceId: z.string().uuid().optional().describe('Set automatically — leave it out'),
    conversationId: z.string().uuid().optional().describe('Set automatically — leave it out')
  },
  // A headless proposal stores the workspace/conversation it was proposed from; the replay (no run)
  // reads those, never whatever `home` resolves to (mirrors export_to_document).
  proposalArgs: async (args, ctx) => ({
    ...args,
    ...(args.workspace_path !== undefined ? { workspaceId: (await workspaceRuntime().resolve(ctx.runId)).workspaceId } : {}),
    conversationId: await conversationIdFor(ctx.runId)
  }),
  handler: async (a, ctx: ToolContext) => {
    const sources = (['html', 'files', 'workspace_path'] as const).filter(k => a[k] !== undefined)
    if (sources.length !== 1) return fail('pass exactly one of html, files or workspace_path', 'publish_artifact: bad arguments')
    try {
      // Snapshot of an existing target (publishing to a known slug): the taint check and the undo both use it.
      // By SLUG only (like the service) — resolveArtifactRef would also match an id.
      const existingId = typeof a.slug === 'string' ? await resolveArtifactRef(a.slug) : null
      const found = existingId ? await getArtifactDetail(existingId) : null
      const before = found && found.slug === a.slug ? found : null
      if (before && refusesPublicTarget(ctx, before.isPublic, a.public)) return fail(PUBLIC_TARGET_REFUSAL, 'publish_artifact: public target in a tainted run')
      const projectId = await projectIdFor(a.project as string | undefined)
      // A live run resolves from its run (model-supplied ids are ignored); a replay (no run) uses the pinned ones.
      const conversationId = ctx.runId ? await conversationIdFor(ctx.runId) : (ctx.replay && typeof a.conversationId === 'string' ? a.conversationId : null)
      let files: PublishInput['files']
      let masked = 0
      let skipped: string[] = []
      if (a.html !== undefined) files = [{ path: 'index.html', content: a.html as string }]
      else if (a.files !== undefined) files = Object.entries(a.files as Record<string, string>).map(([path, content]) => ({ path: normalizeArtifactPath(path), content }))
      else {
        let workspaceId: string
        if (ctx.runId) workspaceId = (await workspaceRuntime().resolve(ctx.runId)).workspaceId
        else if (ctx.replay && typeof a.workspaceId === 'string') {
          const row = await dbWorkspaceStore.get(a.workspaceId)
          if (!row || row.deletedAt) return fail('the workspace this publish was proposed from no longer exists', 'publish_artifact: workspace gone')
          workspaceId = row.id
        } else return fail('workspace_path only works inside Bridget\'s own runs (no workspace here) — pass html or files instead', 'publish_artifact: no workspace')
        const mode = ctx.isTainted ? runNetworkMode(ctx) : 'clean'
        let b: Awaited<ReturnType<typeof readWorkspaceBundle>>
        try {
          b = await readWorkspaceBundle(workspaceId, a.workspace_path as string, { tainted: mode === 'tainted', offline: mode === 'offline', signal: ctx.signal })
        } catch (e) {
          if (e instanceof ArtifactError) throw e
          return fail(errMsg(e), 'publish_artifact: could not read the workspace')
        }
        files = b.files; masked = b.masked; skipped = b.skipped
      }
      const r = await publishArtifact({
        files,
        ...(a.slug !== undefined ? { slug: a.slug as string } : {}),
        ...(a.title !== undefined ? { title: a.title as string } : {}),
        ...(a.description !== undefined ? { description: a.description as string } : {}),
        ...(a.entry !== undefined ? { entry: a.entry as string } : {}),
        ...(a.spa_fallback !== undefined ? { spaFallback: a.spa_fallback as boolean } : {}),
        isPublic: a.public as boolean | undefined,
        ...(projectId !== undefined ? { projectId } : {}),
        conversationId,
        ...(a.merge !== undefined ? { merge: a.merge as boolean } : {})
      })
      const warnings: string[] = []
      const entryPath = normalizeArtifactPath((a.entry as string | undefined) ?? 'index.html')
      const entryFile = files.find(f => normalizeArtifactPath(f.path) === entryPath)
      if (entryFile) {
        const html = typeof entryFile.content === 'string' ? entryFile.content : entryFile.content.toString('utf8')
        if (rootAbsoluteRefs(html, files.map(f => normalizeArtifactPath(f.path))).length)
          warnings.push('entry HTML references root-absolute paths (/assets/…) that will 404 under /artifact/<slug>/ — rebuild with base: \'./\' (Vite) and republish')
      }
      if (masked > 0) warnings.push(`${masked} file(s) had secret values masked`)
      if (skipped.length) warnings.push(`skipped ${skipped.length} file(s) of types artifacts do not serve: ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? ', …' : ''}`)
      const art = r.artifact
      const metaChanged = !!before && (before.isPublic !== art.isPublic || before.title !== art.title
        || before.description !== art.description || before.projectId !== art.projectId)
      const inPlace = !r.created && !r.newVersion && a.merge === true
      const summary = r.created || r.newVersion
        ? `published "${art.title}" v${r.version} → /artifact/${art.slug}/`
        : inPlace ? `updated data of "${art.title}" (v${r.version}, in place)`
          : metaChanged ? `updated "${art.title}" settings (v${r.version} unchanged)` : `"${art.title}" unchanged`
      const exec: ToolExecution = {
        result: okShape(art, { version: r.version, newVersion: r.newVersion, created: r.created, warnings }),
        summary
      }
      if (r.created) exec.undo = async () => { await deleteArtifact(art.id); return { ok: true } }
      else if (r.newVersion || metaChanged) {
        exec.undo = async () => {
          // Metadata first: a previously-private version must never be briefly current on a still-public artifact.
          if (metaChanged && before) await editArtifact(art.id, { title: before.title, description: before.description, isPublic: before.isPublic, projectId: before.projectId })
          if (r.newVersion) await setCurrentVersion(art.id, r.previousVersionId)
          return { ok: true }
        }
      }
      return exec
    } catch (e) {
      if (e instanceof ArtifactError) return fail(e.message, `publish_artifact: ${e.code}`)
      throw e
    }
  }
}

export const editArtifactTool: AgentTool = {
  name: 'edit_artifact',
  toolset: 'artifacts',
  kind: 'create',
  outboundWhen: isPublicCall,
  proposeWhen: isPublicCall,
  description: 'Change an artifact\'s title, description, slug, visibility (`public`), project, or roll its current version back to an earlier one (`rollback_to`: a version number).',
  schema: {
    artifact: z.string().describe('Artifact id or slug'),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    slug: z.string().optional(),
    public: z.boolean().optional(),
    project: z.string().nullable().optional().describe('Project slug; null clears it'),
    rollback_to: z.number().int().positive().optional().describe('Version number to make current')
  },
  handler: async (a, ctx: ToolContext) => {
    try {
      const id = await resolveArtifactRef(a.artifact as string)
      if (!id) return fail(`artifact "${a.artifact}" not found`, 'edit_artifact: not found')
      const before = await getArtifactDetail(id)
      if (!before) return fail(`artifact "${a.artifact}" not found`, 'edit_artifact: not found')
      if (refusesPublicTarget(ctx, before.isPublic, a.public)) return fail(PUBLIC_TARGET_REFUSAL, 'edit_artifact: public target in a tainted run')
      const projectId = a.project === null ? null : await projectIdFor(a.project as string | undefined)
      const dto = await editArtifact(id, {
        ...(a.title !== undefined ? { title: a.title as string } : {}),
        ...(a.description !== undefined ? { description: a.description as string } : {}),
        ...(a.slug !== undefined ? { slug: a.slug as string } : {}),
        ...(a.public !== undefined ? { isPublic: a.public as boolean } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
        ...(a.rollback_to !== undefined ? { rollbackTo: a.rollback_to as number } : {})
      })
      if (!dto) return fail(`artifact "${a.artifact}" not found`, 'edit_artifact: not found')
      const prevVersionId = before.versions.find(v => v.current)?.id ?? null
      return {
        result: okShape(dto, { version: dto.currentVersion, newVersion: false, created: false, warnings: [] as string[] }),
        summary: `edited "${dto.title}" (/artifact/${dto.slug}/)`,
        undo: async () => {
          await editArtifact(id, {
            title: before.title, description: before.description, slug: before.slug, isPublic: before.isPublic, projectId: before.projectId
          })
          if (a.rollback_to !== undefined && prevVersionId) await setCurrentVersion(id, prevVersionId)
          return { ok: true }
        }
      }
    } catch (e) {
      if (e instanceof ArtifactError) return fail(e.message, `edit_artifact: ${e.code}`)
      throw e
    }
  }
}

export const listArtifactsTool: AgentTool = {
  name: 'list_artifacts',
  toolset: 'artifacts',
  kind: 'read',
  description: 'List published artifacts (newest first), optionally for one project.',
  schema: {
    project: z.string().optional().describe('Project slug'),
    limit: z.number().int().min(1).max(100).optional()
  },
  handler: async (a) => {
    try {
      const projectId = await projectIdFor(a.project as string | undefined)
      const rows = await listArtifacts({ ...(projectId ? { projectId } : {}), ...(a.limit !== undefined ? { limit: a.limit as number } : {}) })
      return {
        result: rows.map(r => ({ id: r.id, slug: r.slug, title: r.title, url: r.url, isPublic: r.isPublic, currentVersion: r.currentVersion, updatedAt: r.updatedAt })),
        summary: `${rows.length} artifact(s)`
      }
    } catch (e) {
      if (e instanceof ArtifactError) return fail(e.message, `list_artifacts: ${e.code}`)
      throw e
    }
  }
}

export const deleteArtifactTool: AgentTool = {
  name: 'delete_artifact',
  toolset: 'artifacts',
  kind: 'destructive',
  dangerous: true,
  description: 'Delete an artifact (it stops being served; Tony can undo from the chat).',
  schema: { artifact: z.string().describe('Artifact id or slug') },
  describeApproval: async (a) => {
    const id = await resolveArtifactRef(a.artifact as string)
    const d = id ? await getArtifactDetail(id) : null
    return {
      tool: 'delete_artifact',
      command: d ? `delete artifact "${d.title}" (/artifact/${d.slug}/)` : `delete artifact ${JSON.stringify(a.artifact)}`,
      proposedPattern: 'delete_artifact *'
    }
  },
  handler: async (a) => {
    const id = await resolveArtifactRef(a.artifact as string)
    if (!id) return fail(`artifact "${a.artifact}" not found`, 'delete_artifact: not found')
    const d = await getArtifactDetail(id)
    const ok = await deleteArtifact(id)
    if (!ok) return fail(`artifact "${a.artifact}" not found`, 'delete_artifact: not found')
    return {
      result: { ok: true, id, slug: d?.slug, title: d?.title },
      summary: `deleted "${d?.title ?? a.artifact}"`,
      undo: async () => (await restoreArtifact(id)) ? { ok: true } : { ok: false, reason: 'could not restore (the slug may have been reused)' }
    }
  }
}

/** In the shared registry (and MCP). */
export const artifactTools: AgentTool[] = [publishArtifactTool, editArtifactTool, listArtifactsTool]
/** `dangerous` tools live on bridgetProfile, never in agentTools (test/mcp-dangerous.test.ts) — profile.ts adds these. */
export const artifactDangerousTools: AgentTool[] = [deleteArtifactTool]
