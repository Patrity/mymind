// Cycle 85 fix round 1 (C1 / I2 / Concern 5) / cycle 86: what an eval world leaves OUTSIDE its tenant
// schema — its scratch dir (<evalScratchDir>/<schema>: its workspaces, HOME and tmp) and the files it
// uploaded to storage — plus the worker-boot sweep of tenants (and their leftovers) whose run is gone,
// finished, or older than 2 h. (Cycle 82–85 also removed eval sandbox containers; the host runtime
// has none: every eval command is a confined, foreground process that ends with its call.)
//
// Everything here runs OUTSIDE any eval scope (it is Tony's process cleaning up after a world).
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { inArray } from 'drizzle-orm'
import { useDb } from '../../db'
import { evalRuns } from '../../db/schema'
import { storage } from '../../utils/storage'
import { evalScratchDir, sandboxSettings } from '../sandbox/manager'
import { outsideEvalScope } from './context'
import { dropSchemaNow, evalTenantInfo, schemaExists, tenantOnlyStorageKeys, withTenantLock } from './tenant'

/** Seams (tests). */
export const evalCleanupDeps = {
  rmDir: (dir: string) => rm(dir, { recursive: true, force: true }),
  listDir: (dir: string) => readdir(dir).catch(() => [] as string[]),
  deleteUpload: (key: string) => storage().delete(key),
  listUploads: (schema: string) => tenantOnlyStorageKeys(schema),
  scratchBase: () => sandboxSettings().evalScratchDir,
  log: console as Pick<Console, 'info' | 'warn'>
}

/** Removes a world's scratch dir. */
export function removeEvalWorkspaceDir(worldId: string): Promise<void> {
  return outsideEvalScope(() => evalCleanupDeps.rmDir(evalScratchDir(worldId, evalCleanupDeps.scratchBase())))
}

/** Deletes the files the world uploaded (keys no public row references). Call BEFORE the schema
 *  is dropped. Returns the keys deleted. */
export function deleteEvalUploads(schema: string): Promise<string[]> {
  return outsideEvalScope(async () => {
    const done: string[] = []
    for (const key of await evalCleanupDeps.listUploads(schema)) {
      try { await evalCleanupDeps.deleteUpload(key); done.push(key) } catch (err) {
        evalCleanupDeps.log.warn(`[eval] could not delete upload ${key}: ${(err as Error).message}`)
      }
    }
    return done
  })
}

/** Everything of one world outside its schema: scratch dir, uploads. Never throws. */
export async function cleanupWorldOutside(schema: string): Promise<void> {
  for (const step of [() => removeEvalWorkspaceDir(schema), () => deleteEvalUploads(schema)]) {
    try { await step() } catch (err) { evalCleanupDeps.log.warn(`[eval] cleanup of ${schema} outside its schema failed: ${(err as Error).message}`) }
  }
}

export const SWEEP_MAX_AGE_MS = 2 * 60 * 60_000
/** A tenant whose run has no eval_runs row is kept this long (dev-safe: a test's world, or a
 *  runner that has not written its row yet, is young). */
export const SWEEP_ABSENT_GRACE_MS = 15 * 60_000

export interface SweepResult { schemas: string[]; dirs: string[] }

/**
 * Fix round 2 (N2a / N3): a world's leftovers (scratch dir, uploads) and its schema, removed only
 * while holding its advisory lock — false (nothing touched) when a live world, in any process, holds it.
 */
export async function dropWorldIfFree(schema: string): Promise<{ dropped: boolean; dirRemoved: boolean }> {
  let dirRemoved = false
  const dropped = await withTenantLock(schema, async () => {
    try { await removeEvalWorkspaceDir(schema); dirRemoved = true } catch (err) { evalCleanupDeps.log.warn(`[eval] dir of ${schema}: ${(err as Error).message}`) }
    // Reads the schema: before the drop. A failure here never stops the drop (fix round 3).
    try { await deleteEvalUploads(schema) } catch (err) { evalCleanupDeps.log.warn(`[eval] uploads of ${schema}: ${(err as Error).message}`) }
    await dropSchemaNow(schema)
  })
  return { dropped, dirRemoved }
}

/**
 * Worker boot (I2): drop tenant schemas whose run is finished, whose run row is absent (after a
 * grace), or that are older than 2 h — never one a live world holds (its advisory lock: fix round
 * 2, N2a), never one this process holds (`keep`). A dropped world's scratch dir goes with it, under
 * the same lock (N3); otherwise only ghost dirs (their schema is gone) are removed.
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
    // Fix round 3: only dirs really removed are reported.
    const dirs: string[] = []
    for (const t of infos) {
      const age = t.createdAt ? now - t.createdAt.getTime() : Infinity
      const status = runs.get(t.runId)
      const finished = status !== undefined && status !== 'running' && status !== 'queued'
      const drop = !o.keep?.has(t.schema) && (age > maxAge || finished || (status === undefined && age > grace))
      if (!drop) continue
      try {
        const r = await dropWorldIfFree(t.schema)
        if (r.dropped) { dropped.push(t.schema); if (r.dirRemoved) dirs.push(t.schema) }
      } catch (err) {
        evalCleanupDeps.log.warn(`[eval] sweep could not drop ${t.schema}: ${(err as Error).message}`)
      }
    }
    const base = evalCleanupDeps.scratchBase()
    for (const name of await evalCleanupDeps.listDir(base)) {
      if (dropped.includes(name) || !/^eval_[0-9a-f]{32}_[0-9a-f]{8}$/.test(name) || await schemaExists(name)) continue
      try { await evalCleanupDeps.rmDir(path.join(base, name)); dirs.push(name) } catch (err) {
        evalCleanupDeps.log.warn(`[eval] sweep could not remove ${name}: ${(err as Error).message}`)
      }
    }
    if (dropped.length || dirs.length) evalCleanupDeps.log.info(`[eval] boot sweep: ${dropped.length} tenant(s), ${dirs.length} dir(s) removed`)
    return { schemas: dropped, dirs }
  })
}
