// server/lib/agent/jobs/outcome.ts
// Called by the runtime (queue.ts execute) after finishRun for every run; only runs that a job
// fired (agent_runs.job_id) matter. Writes the job's last_outcome and failure streak, and after
// MAX_CONSECUTIVE_FAILURES in a row disables the job (system revision via store.setJobEnabled)
// and leaves one note in main.
import { eq, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentJobs, type AgentRun } from '../../../db/schema'
import { publishChange } from '../../../utils/live-bus'
import { appendEvent } from '../../../services/conversations'
import { getOrCreateMain } from '../runtime/sessions'
import type { RunOutcome } from '../runtime/types'
import { setJobEnabled } from './store'

export const MAX_CONSECUTIVE_FAILURES = 3

export type JobOutcome = 'spoke' | 'silent' | 'failed'

/** 'aborted' counts as a failure: a headless job run is only aborted by its wall clock. */
export function jobOutcomeOf(o: RunOutcome): JobOutcome {
  if (o.status !== 'done') return 'failed'
  return o.suppressed ? 'silent' : 'spoke'
}

/** `mainConversationId` is the test seam — tests must never write to the real main thread. */
export async function onRunFinished(run: AgentRun, outcome: RunOutcome, opts: { mainConversationId?: string } = {}): Promise<void> {
  if (!run.jobId) return
  const result = jobOutcomeOf(outcome)
  const [job] = await useDb().update(agentJobs).set({
    lastOutcome: result,
    consecutiveFailures: result === 'failed' ? sql`${agentJobs.consecutiveFailures} + 1` : 0
  }).where(eq(agentJobs.id, run.jobId)).returning()
  if (!job) return // the job was deleted while its run was in flight
  publishChange({ resource: 'agentJob', action: 'updated', id: job.id })

  // `enabled` guards the note: a run that was already queued when the job got disabled fails
  // again → streak 4, but the job is off and Tony has already been told.
  if (result !== 'failed' || job.consecutiveFailures < MAX_CONSECUTIVE_FAILURES || !job.enabled) return
  await setJobEnabled(job.slug, false, 'system')
  const mainId = opts.mainConversationId ?? await getOrCreateMain()
  const why = outcome.error ? ` The last error was: ${outcome.error}.` : ''
  await appendEvent(
    mainId,
    `Job ${job.slug} failed ${job.consecutiveFailures} times in a row, so I turned it off.${why} Re-enable it on /jobs/${job.slug} once it is fixed.`,
    'runtime:job-disabled'
  )
}
