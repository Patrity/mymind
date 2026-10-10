/**
 * Pure pieces of the Skills/Jobs editor's explicit-save flow (cycle 74), split out of
 * app/composables/useConfigSource.ts so they are unit-testable without Vue or a network.
 */
import { joinFrontmatter } from '@mymind/core/shared/utils/frontmatter'

export type ConfigKind = 'skill' | 'job' | 'profile'

/** What the editor needs from the server: the markdown and the hash it must send back (CAS). */
export interface SourceSnapshot {
  content: string
  contentHash: string
}

/** HTTP routes and the vue-query key base for each kind. The key base matches what
 *  app/utils/live-dispatch.ts invalidates for the kind's live resource (`agentSkill` ->
 *  ['skills'], `agentJob` -> ['jobs'], `agentProfile` -> ['profile']), so a write elsewhere
 *  refetches the open source. The profile is a singleton (cycle 76): its routes take no slug. */
export function configEndpoints(kind: ConfigKind, slug: string) {
  if (kind === 'profile') {
    return {
      queryBase: 'profile',
      source: '/api/profile/source',
      save: '/api/profile/source',
      revisions: '/api/profile/revisions',
      revert: '/api/profile/revert'
    } as const
  }
  const s = encodeURIComponent(slug)
  if (kind === 'skill') {
    return {
      queryBase: 'skills',
      source: `/api/skills/${s}/source`,
      save: `/api/skills/${s}/source`,
      revisions: `/api/skills/${s}/revisions`,
      revert: `/api/skills/${s}/revert`
    } as const
  }
  return {
    queryBase: 'jobs',
    // GET /api/jobs/:slug wraps the DTO as { job, nextFireTimes, runs }; PUT returns the DTO.
    source: `/api/jobs/${s}`,
    save: `/api/jobs/${s}`,
    revisions: `/api/jobs/${s}/revisions`,
    revert: `/api/jobs/${s}/revert`
  } as const
}

/** Normalises a GET/PUT response of any kind to a snapshot. */
export function toSnapshot(res: unknown): SourceSnapshot {
  const r = res as { job?: SourceSnapshot } & Partial<SourceSnapshot>
  const src = r.job ?? r
  return { content: src.content ?? '', contentHash: src.contentHash ?? '' }
}

/**
 * What to do when the server's copy arrives (first load, or a live-event refetch):
 *  - `ignore` — it is the version we already hold (typically the echo of our own save);
 *  - `adopt`  — someone else changed it and we have no local edits: take theirs silently;
 *  - `flag`   — someone else changed it while we have unsaved edits: keep ours and tell the user.
 */
export function reconcileSnapshot(
  snap: SourceSnapshot,
  state: { savedHash: string | null, dirty: boolean }
): 'ignore' | 'adopt' | 'flag' {
  if (state.savedHash === null) return 'adopt'
  if (snap.contentHash === state.savedHash) return 'ignore'
  return state.dirty ? 'flag' : 'adopt'
}

export type SaveFailure
  = | { kind: 'conflict', current: SourceSnapshot }
    | { kind: 'invalid', message: string }
    | { kind: 'error', message: string }

/**
 * Classifies a failed save from $fetch's FetchError. A 409 carries the server's current copy
 * (server/utils/agent-config-http.ts puts it at `data.current` of the H3 error, which the
 * response body nests as `data.data.current`); a 400 is a validation message to show inline.
 */
export function classifySaveError(err: unknown): SaveFailure {
  const e = err as {
    status?: number
    statusCode?: number
    message?: string
    statusMessage?: string
    data?: { statusMessage?: string, message?: string, current?: SourceSnapshot, data?: { current?: SourceSnapshot } }
  }
  const status = e.status ?? e.statusCode
  const message = e.data?.statusMessage ?? e.data?.message ?? e.statusMessage ?? e.message ?? 'Save failed'
  if (status === 409) {
    const current = e.data?.data?.current ?? e.data?.current
    if (current && typeof current.contentHash === 'string') {
      return { kind: 'conflict', current: { content: current.content ?? '', contentHash: current.contentHash } }
    }
    return { kind: 'error', message }
  }
  if (status === 400) return { kind: 'invalid', message }
  return { kind: 'error', message }
}

/** Starter markdown for a new skill — every field validateSkill requires, so it saves as-is. */
export function skillStarterMarkdown(name: string): string {
  return joinFrontmatter({
    name,
    description: 'One line on what this skill teaches.',
    when_to_use: 'When the agent should load it.',
    active: true,
    source: 'human'
  }, `# ${name}\n\nWrite the how-to here.\n`)
}
