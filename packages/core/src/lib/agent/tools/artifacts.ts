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
import type { AgentTool, ToolContext, ToolExecution } from '../types'

const fail = (error: string, summary = 'artifact: refused'): ToolExecution => ({ result: { ok: false, error }, summary })
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

const isPublicCall = (a: Record<string, unknown>) => a.public === true

/** R10: the web process replays approved proposals in 'remote' execution mode, where the workspace
 *  can't be read — so a headless (no approval channel) public workspace publish is never proposed. */
const HEADLESS_PUBLIC_WORKSPACE = 'publish it privately first (omit public), then ask to make it public with edit_artifact — Tony approves that'

const ENTRY_HEAD_CHARS = 2000
const DETAIL_FILES = 20

/** R9: the approval card for a publish in a tainted run — what would render the moment the chat card mounts. */
async function publishDetail(a: Record<string, unknown>): Promise<string> {
  const lines = ['Publishing renders this page in your chat as soon as it runs — its scripts can contact any site.']
  let target = 'new artifact'
  if (typeof a.slug === 'string') {
    const id = await resolveArtifactRef(a.slug)
    const d = id ? await getArtifactDetail(id) : null
    target = d && d.slug === a.slug
      ? `/artifact/${d.slug}/ (exists, ${d.isPublic ? 'PUBLIC' : 'private'})`
      : `/artifact/${a.slug}/ (new artifact)`
  }
  lines.push(`target: ${target}`, `visibility after: ${a.public === true ? 'PUBLIC' : a.public === false ? 'private' : 'unchanged (new: private)'}`)
  const files = a.files && typeof a.files === 'object' ? Object.keys(a.files as Record<string, string>) : []
  const source = a.html !== undefined ? 'html' : files.length ? 'files' : a.workspace_path !== undefined ? `workspace_path ${String(a.workspace_path)}` : 'none'
  lines.push(`source: ${source}`)
  if (files.length) lines.push(`files (${files.length}): ${files.slice(0, DETAIL_FILES).join(', ')}${files.length > DETAIL_FILES ? ', …' : ''}`)
  const entry = (a.entry as string | undefined) ?? 'index.html'
  const html = typeof a.html === 'string' ? a.html : files.length ? (a.files as Record<string, string>)[entry] ?? (a.files as Record<string, string>)[`./${entry}`] : undefined
  if (typeof html === 'string') {
    lines.push('', `entry HTML (first ${Math.min(html.length, ENTRY_HEAD_CHARS)} of ${html.length} chars):`, html.slice(0, ENTRY_HEAD_CHARS))
  }
  return lines.join('\n')
}

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
  // R9: EVERY publish is outbound — its model-written HTML/JS runs the moment the chat card's iframe
  // mounts (a beacon/navigation is a zero-click exfil), so in a tainted run Tony approves each one
  // (headless: auto-denied). Untainted, it runs freely.
  outbound: true,
  outboundDetail: publishDetail,
  // Headless: a public publish is proposed — except a workspace_path one (R10: refused in the handler).
  proposeWhen: a => a.public === true && a.workspace_path === undefined,
  description: 'Publish a web page or built webapp as an artifact Tony can open at https://brain.costanzoclan.com/artifact/<slug>/ (also shown in chat). Use it when a chart, dashboard, demo or visual preview beats text. Always include the artifact URL in your reply to Tony. Pass `html` for one self-contained page, or build in your workspace first (`pnpm build`; Vite needs `base: \'./\'`) and pass `workspace_path` = the output dir (e.g. `dist`). Use relative asset paths. Pages run sandboxed: no localStorage/cookies, no MyMind API; CDN scripts are fine. Keep refreshable data in `data/*.json`, fetched relatively. To update data, pass `files: {\'data/x.json\': \'<new json>\'}` with `merge: true` (or `workspace_path` of the rebuilt dir); that updates in place. Republishing to the same slug otherwise makes a new version. Private unless `public: true`. Only pass `project` if Tony named one or you looked it up.',
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
    conversationId: z.string().uuid().optional().describe('Set automatically — leave it out')
  },
  // A headless proposal stores the conversation it was proposed from; the replay (no run) reads it.
  // (Proposals never carry workspace_path — R10.)
  proposalArgs: async (args, ctx) => ({ ...args, conversationId: await conversationIdFor(ctx.runId) }),
  handler: async (a, ctx: ToolContext) => {
    // `files: {}` is what models send when they mean "no files" — it counts as absent.
    const hasFiles = a.files !== undefined && Object.keys(a.files as Record<string, string>).length > 0
    const sources = (['html', 'files', 'workspace_path'] as const).filter(k => (k === 'files' ? hasFiles : a[k] !== undefined))
    if (sources.length === 0) return fail('nothing to publish — pass html, files with at least one entry, or workspace_path', 'publish_artifact: nothing to publish')
    if (sources.length !== 1) return fail('pass exactly one of html, files or workspace_path', 'publish_artifact: bad arguments')
    // R10: a live run with no approval channel is headless.
    if (a.workspace_path !== undefined && a.public === true && ctx.runId && !ctx.requestApproval)
      return fail(HEADLESS_PUBLIC_WORKSPACE, 'publish_artifact: headless public workspace publish')
    try {
      // Snapshot of an existing target (publishing to a known slug) for the undo.
      // By SLUG only (like the service) — resolveArtifactRef would also match an id.
      const existingId = typeof a.slug === 'string' ? await resolveArtifactRef(a.slug) : null
      const found = existingId ? await getArtifactDetail(existingId) : null
      const before = found && found.slug === a.slug ? found : null
      const projectId = await projectIdFor(a.project as string | undefined)
      // A live run resolves from its run (model-supplied ids are ignored); a replay (no run) uses the pinned one.
      const conversationId = ctx.runId ? await conversationIdFor(ctx.runId) : (ctx.replay && typeof a.conversationId === 'string' ? a.conversationId : null)
      let files: PublishInput['files']
      let masked = 0
      let skipped: string[] = []
      if (a.html !== undefined) files = [{ path: 'index.html', content: a.html as string }]
      else if (hasFiles) files = Object.entries(a.files as Record<string, string>).map(([path, content]) => ({ path: normalizeArtifactPath(path), content }))
      else {
        if (!ctx.runId) return fail('workspace_path only works inside Bridget\'s own runs (no workspace here) — pass html or files instead', 'publish_artifact: no workspace')
        const workspaceId = (await workspaceRuntime().resolve(ctx.runId)).workspaceId
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
  // R9: making it public, or rolling back to another version (other content renders), is outbound.
  outboundWhen: a => a.public === true || a.rollback_to !== undefined,
  outboundDetail: async (a) => {
    const id = await resolveArtifactRef(a.artifact as string)
    const d = id ? await getArtifactDetail(id) : null
    return d ? `target: /artifact/${d.slug}/ (${d.isPublic ? 'PUBLIC' : 'private'}, current v${d.currentVersion})` : undefined
  },
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
  handler: async (a) => {
    try {
      const id = await resolveArtifactRef(a.artifact as string)
      if (!id) return fail(`artifact "${a.artifact}" not found`, 'edit_artifact: not found')
      const before = await getArtifactDetail(id)
      if (!before) return fail(`artifact "${a.artifact}" not found`, 'edit_artifact: not found')
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
