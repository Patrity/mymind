// Cycle 85 fix round 1 (C1 / I2 / Concern 5): what an eval world leaves OUTSIDE its tenant schema —
// its sandbox containers (labelled mymind.eval.run / mymind.eval.world), its workspace dirs
// (<workspacesDir>/.eval/<schema>) and the files it uploaded to storage — plus the worker-boot sweep
// of tenants (and their leftovers) whose run is gone, finished, or older than 2 h.
//
// Everything here runs OUTSIDE any eval scope (it is Tony's process cleaning up after a world).
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { inArray } from 'drizzle-orm'
import { useDb } from '../../db'
import { evalRuns } from '../../db/schema'
import { storage } from '../../utils/storage'
import { createDockerCli, dockerAvailable, LABEL_EVAL_RUN, LABEL_EVAL_WORLD, type DockerRunner } from '../sandbox/docker'
import { evalWorkspacesDir, sandboxSettings } from '../sandbox/manager'
import { outsideEvalScope } from './context'
import { dropEvalSchema, evalTenantInfo, tenantOnlyStorageKeys } from './tenant'

/** Seams (tests). */
export const evalCleanupDeps = {
  docker: null as DockerRunner | null,
  rmDir: (dir: string) => rm(dir, { recursive: true, force: true }),
  listDir: (dir: string) => readdir(dir).catch(() => [] as string[]),
  deleteUpload: (key: string) => storage().delete(key),
  workspacesBase: () => sandboxSettings().workspacesDir,
  log: console as Pick<Console, 'info' | 'warn'>
}

const docker = () => evalCleanupDeps.docker ?? createDockerCli()

/** Eval containers, each with its world: every one of a run, of a world, or (no filter) all. */
async function listEvalContainers(filter: { runId?: string; worldId?: string } = {}): Promise<{ id: string; world: string }[]> {
  const d = docker()
  if (!await dockerAvailable(d)) return []
  const label = filter.runId ? `${LABEL_EVAL_RUN}=${filter.runId}` : filter.worldId ? `${LABEL_EVAL_WORLD}=${filter.worldId}` : LABEL_EVAL_RUN
  const r = await d(['ps', '-a', '--no-trunc', '--filter', `label=${label}`, '--format', `{{.ID}} {{.Label "${LABEL_EVAL_WORLD}"}}`], { timeoutMs: 30_000 })
  if (r.code !== 0) throw new Error(`docker ps failed: ${r.stderr.trim()}`)
  return r.stdout.split('\n').map(l => l.trim()).filter(Boolean).map((l) => {
    const [id, world] = l.split(' ')
    return { id: id!, world: world ?? '' }
  })
}

async function removeContainers(ids: string[]): Promise<string[]> {
  const d = docker()
  const removed: string[] = []
  for (const id of ids) {
    const r = await d(['rm', '-f', id], { timeoutMs: 30_000 })
    if (r.code === 0 || /No such container/i.test(r.stderr)) removed.push(id)
    else evalCleanupDeps.log.warn(`[eval] could not remove sandbox container ${id}: ${r.stderr.trim()}`)
  }
  return removed
}

/** Removes the sandbox containers of a run or a world. Returns their ids. */
export function removeEvalContainers(filter: { runId?: string; worldId?: string }): Promise<string[]> {
  return outsideEvalScope(async () => removeContainers((await listEvalContainers(filter)).map(c => c.id)))
}

/** Removes a world's workspace dir. */
export function removeEvalWorkspaceDir(worldId: string): Promise<void> {
  return outsideEvalScope(() => evalCleanupDeps.rmDir(evalWorkspacesDir(worldId, evalCleanupDeps.workspacesBase())))
}

/** Deletes the files the world uploaded (keys no public row references). Call BEFORE the schema
 *  is dropped. Returns the keys deleted. */
export function deleteEvalUploads(schema: string): Promise<string[]> {
  return outsideEvalScope(async () => {
    const done: string[] = []
    for (const key of await tenantOnlyStorageKeys(schema)) {
      try { await evalCleanupDeps.deleteUpload(key); done.push(key) } catch (err) {
        evalCleanupDeps.log.warn(`[eval] could not delete upload ${key}: ${(err as Error).message}`)
      }
    }
    return done
  })
}

/** Everything of one world outside its schema: containers, workspace dir, uploads. Never throws. */
export async function cleanupWorldOutside(schema: string): Promise<void> {
  for (const step of [() => removeEvalContainers({ worldId: schema }), () => removeEvalWorkspaceDir(schema), () => deleteEvalUploads(schema)]) {
    try { await step() } catch (err) { evalCleanupDeps.log.warn(`[eval] cleanup of ${schema} outside its schema failed: ${(err as Error).message}`) }
  }
}

export const SWEEP_MAX_AGE_MS = 2 * 60 * 60_000
/** A tenant whose run has no eval_runs row is kept this long (dev-safe: a test's world, or a
 *  runner that has not written its row yet, is young). */
export const SWEEP_ABSENT_GRACE_MS = 15 * 60_000

export interface SweepResult { schemas: string[]; containers: string[]; dirs: string[] }

/**
 * Worker boot (I2): drop tenant schemas whose run is finished, whose run row is absent (after a
 * grace), or that are older than 2 h — never a live run's young world, never one this process
 * holds (`keep`). Then remove eval containers and workspace dirs whose world no longer exists.
 */
export async function sweepEvalLeftovers(o: { now?: number; keep?: Set<string>; maxAgeMs?: number; absentGraceMs?: number } = {}): Promise<SweepResult> {
  return outsideEvalScope(async () => {
    const now = o.now ?? Date.now()
    const maxAge = o.maxAgeMs ?? SWEEP_MAX_AGE_MS
    const grace = o.absentGraceMs ?? SWEEP_ABSENT_GRACE_MS
    const infos = await evalTenantInfo()
    const runIds = [...new Set(infos.map(i => i.runId))]
    const runs = new Map<string, string>()
    if (runIds.length) {
      for (const r of await useDb().select({ id: evalRuns.id, status: evalRuns.status }).from(evalRuns).where(inArray(evalRuns.id, runIds))) runs.set(r.id, r.status)
    }
    const dropped: string[] = []
    const surviving = new Set<string>()
    for (const t of infos) {
      const age = t.createdAt ? now - t.createdAt.getTime() : Infinity
      const status = runs.get(t.runId)
      const finished = status !== undefined && status !== 'running' && status !== 'queued'
      const drop = !o.keep?.has(t.schema) && (age > maxAge || finished || (status === undefined && age > grace))
      if (!drop) { surviving.add(t.schema); continue }
      try {
        await deleteEvalUploads(t.schema)
        await dropEvalSchema(t.schema)
        dropped.push(t.schema)
      } catch (err) {
        surviving.add(t.schema)
        evalCleanupDeps.log.warn(`[eval] sweep could not drop ${t.schema}: ${(err as Error).message}`)
      }
    }
    let containers: string[] = []
    try {
      containers = await removeContainers((await listEvalContainers()).filter(c => !surviving.has(c.world)).map(c => c.id))
    } catch (err) { evalCleanupDeps.log.warn(`[eval] sweep could not list sandbox containers: ${(err as Error).message}`) }
    const dirs: string[] = []
    const base = path.join(evalCleanupDeps.workspacesBase(), '.eval')
    for (const name of await evalCleanupDeps.listDir(base)) {
      if (surviving.has(name) || !/^eval_[0-9a-f]{32}_[0-9a-f]{8}$/.test(name)) continue
      try { await evalCleanupDeps.rmDir(path.join(base, name)); dirs.push(name) } catch (err) {
        evalCleanupDeps.log.warn(`[eval] sweep could not remove ${name}: ${(err as Error).message}`)
      }
    }
    if (dropped.length || containers.length || dirs.length) evalCleanupDeps.log.info(`[eval] boot sweep: ${dropped.length} tenant(s), ${containers.length} container(s), ${dirs.length} dir(s) removed`)
    return { schemas: dropped, containers, dirs }
  })
}
