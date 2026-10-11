// Cycle 81 (spec §5.3): the workstream tools.
//   start_workstream  — Bridget's (core toolset, profile-only like load_toolsets: never on MCP).
//                       NOT available inside a workstream (no recursion this step): the workstream
//                       registry (profile.ts workstreamProfile) leaves it out, and the handler refuses
//                       a workstream run anyway.
//   finish_workstream — workstream runs only: done + the summary posted to the origin conversation.
//   ask_tony          — workstream runs only: attention + a notification; resumes on his reply.
// Never-throw contract (tools/jobs.ts): every failure is `{ ok: false, error }`.
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentRuns } from '../../../db/schema'
import type { AgentTool } from '../types'
import { ON_DEMAND_TOOLSETS, type ToolsetId } from '../toolsets'
import { getWorkstream, patchWorkstream } from '../workstreams/store'
import { BUDGET_LIMITS, workstreamPath } from '../../../shared/types/workstreams'

const fail = (name: string, err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  return { result: { ok: false, error: message }, summary: `${name} failed: ${message}` }
}

const NOT_IN_WORKSTREAM = 'only works inside a workstream'

// The loop and the notifier are imported at CALL time: this module is loaded by profile.ts, and the
// loop's own imports reach back to profile (notify → channels → queue → runner → profile) — a static
// import here would make the load order matter (it broke a replay-first entry in the review round).
const loop = () => import('../workstreams/loop')
const notify = () => import('../workstreams/notify')

export const startWorkstreamTool: AgentTool = {
  name: 'start_workstream',
  toolset: 'core',
  kind: 'create',
  // Model-chosen text becomes later unattended work (like a job or a wake): after a Google read is
  // in context it goes through the approval gate (cycle 79b).
  outbound: true,
  description: 'Start a WORKSTREAM: long-running background work (research, a multi-step build-out) that keeps going on its own — across many steps, while Tony is away, and across restarts — in its own thread, within a budget. Use it when a task needs far more steps than one reply, not for quick answers. Give a self-contained goal (it cannot see this conversation). Returns its id and link; Tony is told when it finishes or needs him.',
  schema: {
    goal: z.string().min(3).max(4000).describe('What to achieve, self-contained: the task, constraints, and what "done" looks like'),
    toolsets: z.array(z.enum(ON_DEMAND_TOOLSETS as [ToolsetId, ...ToolsetId[]])).optional().describe('On-demand toolsets to pre-load (it can still load others)'),
    budget: z.object({
      maxSteps: z.number().int().min(BUDGET_LIMITS.maxSteps.min).max(BUDGET_LIMITS.maxSteps.max).optional(),
      maxWallMs: z.number().int().min(BUDGET_LIMITS.maxWallMs.min).max(BUDGET_LIMITS.maxWallMs.max).optional()
    }).optional().describe('Default 400 model steps and 2 hours of active time')
  },
  handler: async (a, ctx) => {
    try {
      let origin: string | null = null
      if (ctx.runId) {
        const [run] = await useDb().select({ kind: agentRuns.kind, conversationId: agentRuns.conversationId }).from(agentRuns).where(eq(agentRuns.id, ctx.runId)).limit(1)
        if (run?.kind === 'workstream' || (await loop()).segmentForRun(ctx.runId)) {
          return { result: { ok: false, error: 'a workstream cannot start another workstream' }, summary: 'start_workstream refused inside a workstream' }
        }
        origin = run?.conversationId ?? null
      }
      const ws = await (await loop()).startWorkstream({
        goal: a.goal as string,
        toolsets: a.toolsets as string[] | undefined,
        budget: a.budget as { maxSteps?: number; maxWallMs?: number } | undefined,
        originConversationId: origin
      })
      return {
        result: { ok: true, id: ws.id, link: workstreamPath(ws.id), conversationId: ws.conversationId, state: ws.state, budget: ws.budget },
        summary: `started workstream: ${ws.goal.length > 80 ? `${ws.goal.slice(0, 79)}…` : ws.goal}`
      }
    } catch (err) {
      return fail('start_workstream', err)
    }
  }
}

export const finishWorkstreamTool: AgentTool = {
  name: 'finish_workstream',
  toolset: 'core',
  kind: 'create',
  description: 'The goal is done: end this workstream with a summary for Tony (what you did, what you found, sources, anything left open). Nothing else ends a workstream.',
  schema: { summary: z.string().min(1).max(8000).describe('The final report, markdown') },
  handler: async (a, ctx) => {
    try {
      const seg = (await loop()).segmentForRun(ctx.runId)
      if (!seg) return { result: { ok: false, error: `finish_workstream ${NOT_IN_WORKSTREAM}` }, summary: 'finish_workstream: not a workstream' }
      const summary = (a.summary as string).trim()
      const ws = await patchWorkstream(seg.workstreamId, { state: 'done', summary, attention: null, finishedAt: new Date() }, ['running', 'attention'])
      if (!ws) return { result: { ok: false, error: 'the workstream is no longer running' }, summary: 'finish_workstream: not running' }
      seg.stop = 'finished'
      await (await notify()).notifyTony(ws, `⚙ Workstream done — ${ws.goal}\n\n${summary}`)
      return { result: { ok: true, state: 'done' }, summary: 'workstream finished' }
    } catch (err) {
      return fail('finish_workstream', err)
    }
  }
}

export const askTonyTool: AgentTool = {
  name: 'ask_tony',
  toolset: 'core',
  kind: 'create',
  description: 'You are BLOCKED on a decision or information only Tony has: ask him. He is notified (a text when he is away); the workstream pauses until he replies (in its thread, or by answering the text). Do not use it for routine choices you can make yourself.',
  schema: { question: z.string().min(1).max(2000).describe('One clear question, with the options if there are any') },
  handler: async (a, ctx) => {
    try {
      const { segmentForRun, questionNote } = await loop()
      const seg = segmentForRun(ctx.runId)
      if (!seg) return { result: { ok: false, error: `ask_tony ${NOT_IN_WORKSTREAM}` }, summary: 'ask_tony: not a workstream' }
      const question = (a.question as string).trim()
      const ws = await patchWorkstream(seg.workstreamId, { state: 'attention', attention: { kind: 'question', text: question, notifiedAt: Date.now() } }, ['running', 'attention'])
      if (!ws) return { result: { ok: false, error: 'the workstream is no longer running' }, summary: 'ask_tony: not running' }
      seg.stop = 'attention'
      await (await notify()).notifyTony(ws, questionNote(ws.goal, question))
      return { result: { ok: true, note: 'Tony has been asked. Stop here: the workstream resumes when he replies.' }, summary: 'asked Tony' }
    } catch (err) {
      return fail('ask_tony', err)
    }
  }
}

export const answerWorkstreamTool: AgentTool = {
  name: 'answer_workstream',
  toolset: 'core',
  kind: 'create',
  description: "Pass Tony's answer to a workstream that asked him a question (ask_tony) — when he answers it here instead of in its thread. The id is in the workstream's note (…/workstreams/<id>). The workstream resumes with his words.",
  schema: {
    id: z.string().uuid().describe('The workstream id'),
    text: z.string().min(1).max(4000).describe("Tony's answer, in his words")
  },
  handler: async (a, ctx) => {
    try {
      const { segmentForRun, replyToWorkstream } = await loop()
      if (segmentForRun(ctx.runId)) return { result: { ok: false, error: 'answer_workstream is for Bridget, not a workstream' }, summary: 'answer_workstream: refused' }
      const ws = await getWorkstream(a.id as string)
      if (!ws) return { result: { ok: false, error: 'no such workstream' }, summary: 'answer_workstream: not found' }
      const r = await replyToWorkstream(ws, { text: (a.text as string).trim(), modality: 'text' })
      if (!r) return { result: { ok: false, error: `that workstream is ${ws.state}` }, summary: `answer_workstream: ${ws.state}` }
      const { kickPump } = await import('../runtime/queue')
      kickPump()
      return { result: { ok: true, state: 'running' }, summary: `answered: ${ws.goal.length > 60 ? `${ws.goal.slice(0, 59)}…` : ws.goal}` }
    } catch (err) {
      return fail('answer_workstream', err)
    }
  }
}

/** Tools only a workstream segment has. */
export const workstreamOnlyTools: AgentTool[] = [finishWorkstreamTool, askTonyTool]
