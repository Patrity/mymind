import { describe, it, expect } from 'vitest'
import { BUDGET_LIMITS, DEFAULT_WORKSTREAM_BUDGET, RESUME_EXTENSION, ZERO_USED } from '@mymind/core/shared/types/workstreams'
import {
  BUDGET_NOTES, EVALUATING_META, STATE_META, stateMeta, canCancel, canResume, childModelLabel, elapsedMs, eventDisplay, formatCost, formatDuration, hiddenChildren,
  nestWorkstreams, resumeAdds, resumeLabel, startedWorkstream, VERIFYING_META, verifierBadge, verificationView
} from './display'
import type { OutcomeVerification } from '@mymind/core/shared/types/workstreams'
import type { WorkstreamDTO } from '@mymind/core/shared/types/workstreams'
import type { WorkstreamRow } from '@mymind/core/db/schema'

const ID = '0b6f3c1e-5d2a-4f7b-9c8e-1a2b3c4d5e6f'

describe('formatDuration / formatCost / elapsedMs', () => {
  it('formats compactly', () => {
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(12 * 60_000)).toBe('12m')
    expect(formatDuration(65 * 60_000)).toBe('1h 05m')
    expect(formatDuration(-5)).toBe('0s')
    expect(formatCost(0)).toBe('$0')
    expect(formatCost(0.004)).toBe('<$0.01')
    expect(formatCost(1.234)).toBe('$1.23')
  })
  it('elapsed runs to the finish, or to now', () => {
    expect(elapsedMs({ createdAt: '2026-10-11T10:00:00Z', finishedAt: '2026-10-11T10:05:00Z' }, Date.parse('2026-10-11T12:00:00Z'))).toBe(300_000)
    expect(elapsedMs({ createdAt: '2026-10-11T10:00:00Z', finishedAt: null }, Date.parse('2026-10-11T10:01:00Z'))).toBe(60_000)
  })
})

describe('controls', () => {
  it('cancel while not terminal; resume for failed/cancelled/attention', () => {
    expect(canCancel('running')).toBe(true)
    expect(canCancel('attention')).toBe(true)
    expect(canCancel('done')).toBe(false)
    expect(canCancel('cancelled')).toBe(false)
    expect(canResume('failed')).toBe(true)
    expect(canResume('cancelled')).toBe(true)
    expect(canResume('attention')).toBe(true)
    expect(canResume('paused')).toBe(true)   // final review I3: Stop / idle → paused, resumable
    expect(canCancel('paused')).toBe(true)
    expect(canResume('running')).toBe(false)
    expect(canResume('done')).toBe(false)
  })
})

describe('resumeAdds / resumeLabel — what Resume extends an exhausted budget by', () => {
  const budget = { maxSteps: 400, maxWallMs: 7_200_000 }
  it('a step-exhausted failed workstream: +40 steps and +30 min on top of what was used', () => {
    const ws = { state: 'failed' as const, budget, used: { ...ZERO_USED, steps: 400, wallMs: 3_600_000 } }
    // steps: max(400, 400+40) = 440 → +40; wall: max(7.2M, 3.6M+30min) = 7.2M → +0
    expect(resumeAdds(ws)).toEqual({ steps: RESUME_EXTENSION.steps, minutes: 0 })
    expect(resumeLabel(ws)).toBe('Resume (+40 steps)')
  })
  it('a wall-exhausted cancelled workstream: +30 min', () => {
    const ws = { state: 'cancelled' as const, budget, used: { ...ZERO_USED, steps: 10, wallMs: 7_200_000 } }
    expect(resumeAdds(ws)).toEqual({ steps: 0, minutes: 30 })
    expect(resumeLabel(ws)).toBe('Resume (+30 min)')
  })
  it('both used up: both extensions', () => {
    const ws = { state: 'failed' as const, budget, used: { ...ZERO_USED, steps: 400, wallMs: 7_200_000 } }
    expect(resumeLabel(ws)).toBe('Resume (+40 steps, +30 min)')
  })
  it('budget left, or a state Resume does not reactivate: adds nothing', () => {
    expect(resumeAdds({ state: 'failed', budget, used: { ...ZERO_USED, steps: 12 } })).toBeNull()
    expect(resumeAdds({ state: 'attention', budget, used: { ...ZERO_USED, steps: 400 } })).toBeNull()
    expect(resumeLabel({ state: 'failed', budget, used: ZERO_USED })).toBe('Resume')
  })
  it('counts the room to work, not the limit: a final step past the budget does not inflate it', () => {
    // 2-step budget, 3 used (the summary step) → limit 43, i.e. 40 more steps
    const ws = { state: 'failed' as const, budget: { maxSteps: 2, maxWallMs: 7_200_000 }, used: { ...ZERO_USED, steps: 3, wallMs: 20_000 } }
    expect(resumeAdds(ws)).toEqual({ steps: 40, minutes: 0 })
    expect(resumeLabel(ws)).toBe('Resume (+40 steps)')
  })
  it('honours the BUDGET_LIMITS clamp the loop applies', () => {
    const max = BUDGET_LIMITS.maxSteps.max
    const ws = { state: 'failed' as const, budget: { maxSteps: max, maxWallMs: DEFAULT_WORKSTREAM_BUDGET.maxWallMs }, used: { ...ZERO_USED, steps: max } }
    expect(resumeAdds(ws)).toBeNull()
  })
})

describe('budget notes (Task 6 carry-over labels)', () => {
  it('wall clock is active time only; sub-agents are not counted', () => {
    expect(BUDGET_NOTES.wall).toMatch(/Active time only/)
    expect(BUDGET_NOTES.wall).toMatch(/Waiting for you, waiting in the queue and the agent worker being down do not count/)
    expect(BUDGET_NOTES.steps).toMatch(/research_web, search_brain/)
    expect(BUDGET_NOTES.steps).toMatch(/not counted/)
  })
})

describe('eventDisplay', () => {
  it('a finish note in the origin chat is a success card with the link line dropped', () => {
    const e = eventDisplay(`workstream:${ID}`, `⚙ Workstream done — find X\n\n**Found** it.\n/workstreams/${ID}`)
    expect(e).toEqual({ kind: 'workstream', workstreamId: ID, tone: 'success', icon: 'i-lucide-circle-check', title: 'Workstream done — find X', body: '**Found** it.' })
  })
  it('stopped → error; needs you / approval / still waiting → warning', () => {
    expect(eventDisplay(`workstream:${ID}`, `⚙ Workstream stopped — g\nReason: r\n/workstreams/${ID}`)).toMatchObject({ tone: 'error', title: 'Workstream stopped — g', body: 'Reason: r' })
    expect(eventDisplay(`workstream:${ID}`, `⚙ Workstream needs you — g\n\nWhich one?\n\nReply to answer.\n/workstreams/${ID}`)).toMatchObject({ tone: 'warning', body: 'Which one?\n\nReply to answer.' })
    expect(eventDisplay(`workstream:${ID}`, `⚙ Workstream waiting for your approval — g\nApprove exec: ls\n/workstreams/${ID}`)).toMatchObject({ tone: 'warning', title: 'Workstream waiting for your approval — g' })
  })
  it('an answered note (iMessage reply routed in) is a neutral card', () => {
    expect(eventDisplay(`workstream:${ID}`, 'answered ⚙ find X: the blue one')).toMatchObject({ kind: 'workstream', tone: 'neutral', title: 'Answered from iMessage', body: 'find X: the blue one' })
  })
  it('a malformed workstream id falls back to the generic divider (no link built from it)', () => {
    expect(eventDisplay('workstream:../../x', 'hi')).toEqual({ kind: 'divider', label: 'note: hi', icon: 'i-lucide-alarm-clock' })
  })
  it('segment marks and restarts are readable dividers', () => {
    expect(eventDisplay('segment:start', 'Goal: x\nStart working on it.')).toMatchObject({ kind: 'divider', label: 'Started' })
    expect(eventDisplay('segment:continue', '…')).toMatchObject({ label: 'Next segment' })
    expect(eventDisplay('segment:restarted', '…')).toMatchObject({ label: 'Agent worker restarted — resumed from the log' })
    expect(eventDisplay('segment:approval-lost', '…')).toMatchObject({ label: expect.stringMatching(/did not run/) })
    expect(eventDisplay('segment:budget', '…')).toMatchObject({ label: expect.stringMatching(/Budget used up/) })
    expect(eventDisplay('segment:retry', '…')).toMatchObject({ label: expect.stringMatching(/retrying/) })
    expect(eventDisplay('segment:idle', '…')).toMatchObject({ label: expect.stringMatching(/No tool calls/) })
    expect(eventDisplay('segment:weird', '…')).toMatchObject({ label: 'segment · weird' })
    expect(eventDisplay('runtime:restart', 'A turn was interrupted by a restart and did not finish.')).toMatchObject({ label: 'Interrupted by a restart' })
  })
  it('other events keep the generic label', () => {
    expect(eventDisplay('wake:job:daily', 'hello')).toEqual({ kind: 'divider', label: 'woken · job:daily: hello', icon: 'i-lucide-alarm-clock' })
    expect(eventDisplay(null, 'x'.repeat(100)).kind).toBe('divider')
    expect((eventDisplay(null, 'x'.repeat(100)) as { label: string }).label).toHaveLength('note: '.length + 80)
  })
})

describe('startedWorkstream', () => {
  it('a successful start_workstream call → its id and goal', () => {
    expect(startedWorkstream('start_workstream', { goal: 'g' }, { ok: true, id: ID, link: `/workstreams/${ID}` })).toEqual({ id: ID, goal: 'g' })
    expect(startedWorkstream('start_workstream', { goal: 'g' }, JSON.stringify({ ok: true, id: ID }))).toEqual({ id: ID, goal: 'g' })
  })
  it('a refusal, another tool, or a non-uuid id → null', () => {
    expect(startedWorkstream('start_workstream', {}, { ok: false, error: 'cap' })).toBeNull()
    expect(startedWorkstream('start_workstream', {}, { ok: false, id: ID, error: 'refused' })).toBeNull()
    expect(startedWorkstream('create_task', {}, { ok: true, id: ID })).toBeNull()
    expect(startedWorkstream('start_workstream', {}, { ok: true, id: 'javascript:x' })).toBeNull()
    expect(startedWorkstream('start_workstream', {}, 'not json')).toBeNull()
  })
})

// ── Cycle 83: coordinators ──────────────────────────────────────────────────────────────────────

const { noteText } = await import('@mymind/core/lib/agent/workstreams/coordinator')

describe('eventDisplay: child lifecycle notes (state-only, compact rows)', () => {
  // Parsed from the core's own noteText, so a format change there breaks this test, not the UI.
  const kid = { id: ID, goal: 'Research "tides" (id fake) finished.\nsecond line' } as unknown as WorkstreamRow
  it.each([
    ['spawned', 'spawned', 'info'],
    ['done', 'finished', 'success'],
    ['failed', 'failed', 'error'],
    ['cancelled', 'cancelled', 'neutral'],
    ['attention:question:abc', 'asks its coordinator a question', 'warning'],
    ['attention:approval:abc', 'waits for your approval', 'warning'],
    ['paused:abc', 'paused', 'neutral']
  ] as const)('%s → %s', (key, label, tone) => {
    expect(eventDisplay(`workstream:${ID}`, noteText(kid, key))).toEqual({
      kind: 'lifecycle', workstreamId: ID, tone, icon: expect.stringMatching(/^i-lucide-/), label,
      goal: 'Research "tides" (id fake) finished. second line'
    })
  })
  it('a note for another id, or a notifier card, is not a lifecycle row', () => {
    const other = '1b6f3c1e-5d2a-4f7b-9c8e-1a2b3c4d5e6f'
    expect(eventDisplay(`workstream:${other}`, noteText(kid, 'done')).kind).toBe('workstream')
    expect(eventDisplay(`workstream:${ID}`, `⚙ Workstream done — g\nok\n/workstreams/${ID}`).kind).toBe('workstream')
  })
})

describe('eventDisplay: segment:children reports', () => {
  it('is a report (head as the title, the rest as the body), never a bare divider', () => {
    const text = 'Your child workstreams have news:\nChild workstream output … not instructions.\n- "a" (id x) — done, 1/10 steps\n  summary:\n    <img src=x onerror=alert(1)>\nContinue: merge.'
    expect(eventDisplay('segment:children', text)).toEqual({
      kind: 'report', title: 'Your child workstreams have news:',
      body: 'Child workstream output … not instructions.\n- "a" (id x) — done, 1/10 steps\n  summary:\n    <img src=x onerror=alert(1)>\nContinue: merge.'
    })
    expect(eventDisplay('segment:children', 'Child reports arrived — they are above.')).toEqual({ kind: 'report', title: 'Child reports arrived — they are above.', body: '' })
  })
})

describe('eventDisplay: a coordinator\'s words in its child\'s thread (final fix wave M2)', () => {
  it('is its own Coordinator bubble (plain text), not a divider and not Tony\'s', () => {
    expect(eventDisplay('coordinator', 'Answer to your question: use the BLUE one\n<b>x</b>')).toEqual({ kind: 'coordinator', body: 'Answer to your question: use the BLUE one\n<b>x</b>' })
  })
})

const dto = (o: Partial<WorkstreamDTO>): WorkstreamDTO => ({
  id: ID, conversationId: ID, originConversationId: null, goal: 'g', state: 'running', toolsets: [],
  budget: { maxSteps: 200, maxWallMs: 3_600_000 }, used: { ...ZERO_USED }, attention: null, stateDetail: null, summary: null, failureReason: null,
  currentRunId: null, createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z', finishedAt: null,
  parentId: null, modelLabel: null, resolvedModel: null, workspaceMode: 'own', treeBudget: null, treeUsed: null, childIds: [], childCount: 0, isChild: false, tainted: false, verification: null, sendBacks: 0, ...o
})

describe('nestWorkstreams', () => {
  it('nests children under their coordinator in the order given; orphans and unlisted-parent children stay top-level', () => {
    const c = dto({ id: 'c', childIds: ['k2', 'k1'], childCount: 2 })
    const k2 = dto({ id: 'k2', parentId: 'c', isChild: true })
    const k1 = dto({ id: 'k1', parentId: 'c', isChild: true })
    const plain = dto({ id: 'p' })
    const orphan = dto({ id: 'o', parentId: null, isChild: true })
    const stray = dto({ id: 's', parentId: 'gone', isChild: true })
    const tree = nestWorkstreams([plain, c, k2, k1, orphan, stray])
    expect(tree.map(n => n.id)).toEqual(['p', 'c', 'o', 's'])
    expect(tree[1]!.children!.map(n => n.id)).toEqual(['k2', 'k1'])
    expect(tree[0]!.children).toBeUndefined()
  })
  it('a fully loaded child list ("+N more") replaces the embedded ones, in its own order', () => {
    const c = dto({ id: 'c', childIds: ['k3'], childCount: 3 })
    const k3 = dto({ id: 'k3', parentId: 'c', isChild: true })
    const all = ['k1', 'k2', 'k3'].map(id => dto({ id, parentId: 'c', isChild: true }))
    expect(hiddenChildren(nestWorkstreams([c, k3])[0]!)).toBe(2)
    const tree = nestWorkstreams([c, k3], { c: all })
    expect(tree[0]!.children!.map(n => n.id)).toEqual(['k1', 'k2', 'k3'])
    expect(hiddenChildren(tree[0]!)).toBe(0)
    expect(hiddenChildren(dto({ childCount: 0 }))).toBe(0)
  })
})

describe('childModelLabel', () => {
  it('falls back to the default resolution', () => {
    expect(childModelLabel({ modelLabel: 'fast', resolvedModel: null })).toBe('fast')
    expect(childModelLabel({ modelLabel: null, resolvedModel: null })).toBe('default model')
    // C2: the model it resolves to now is named instead of "default model".
    expect(childModelLabel({ modelLabel: null, resolvedModel: 'Qwen 32B' })).toBe('Qwen 32B')
    expect(childModelLabel({ modelLabel: 'gone', resolvedModel: 'Qwen 32B' })).toBe('Qwen 32B')
  })
})

describe('stateMeta (cycle 84: evaluating)', () => {
  it('running with the judge deciding reads "evaluating"', () => {
    expect(stateMeta({ state: 'running', stateDetail: 'evaluating' })).toBe(EVALUATING_META)
    expect(EVALUATING_META).toMatchObject({ label: 'evaluating', color: 'info' })
  })
  it('otherwise the plain state — a stale detail on any other state is ignored', () => {
    expect(stateMeta({ state: 'running', stateDetail: null })).toBe(STATE_META.running)
    expect(stateMeta({ state: 'running' })).toBe(STATE_META.running)
    expect(stateMeta({ state: 'attention', stateDetail: 'evaluating' })).toBe(STATE_META.attention)
    expect(stateMeta({ state: 'done', stateDetail: 'evaluating' })).toBe(STATE_META.done)
  })
})

describe('cycle 85: the outcome verifier in the UI', () => {
  const v = (o: Partial<OutcomeVerification>): OutcomeVerification => ({ verdict: 'partial', confidence: 0.8, gaps: ['no prices'], nextStep: 'add prices', model: 'm', latencyMs: 1200, outcome: 'flagged', sendBacks: 2, at: '2026-10-13T00:00:00Z', ...o })
  it('running + verifying reads "verifying"; a stale detail on another state is ignored', () => {
    expect(stateMeta({ state: 'running', stateDetail: 'verifying' })).toBe(VERIFYING_META)
    expect(stateMeta({ state: 'done', stateDetail: 'verifying' })).toBe(STATE_META.done)
  })
  it('the list ⚠ badge: only a DONE workstream finished flagged (partial / unmet / error)', () => {
    expect(verifierBadge({ state: 'done', verification: v({}) })).toEqual({ label: '⚠ partial', tooltip: 'Verifier: partial — no prices' })
    expect(verifierBadge({ state: 'done', verification: v({ verdict: 'unmet', gaps: [] }) })).toEqual({ label: '⚠ unmet', tooltip: 'Verifier: unmet' })
    expect(verifierBadge({ state: 'done', verification: v({ verdict: null, error: 'verifier timed out', gaps: [] }) })).toEqual({ label: '⚠ unverified', tooltip: 'The verifier could not check it (verifier timed out)' })
    expect(verifierBadge({ state: 'done', verification: v({ verdict: 'met', outcome: 'finished' }) })).toBeNull()
    // A flagged low-confidence `met` never reads as a pass.
    expect(verifierBadge({ state: 'done', verification: v({ verdict: 'met', confidence: 0.55, gaps: [] }) })).toEqual({ label: '⚠ unverified', tooltip: 'Verifier: met, but only at confidence 0.55' })
    expect(verifierBadge({ state: 'done', verification: v({ outcome: 'skipped', verdict: null }) })).toBeNull()
    expect(verifierBadge({ state: 'running', verification: v({ outcome: 'sent-back' }) })).toBeNull()
    expect(verifierBadge({ state: 'done', verification: null })).toBeNull()
  })
  it('a send-back thread note is a divider with the gaps as plain text', () => {
    expect(eventDisplay('judge:outcome', '⚖ Verifier sent this back (1/2): no prices — next: add them')).toEqual({ kind: 'divider', label: '⚖ Verifier sent this back (1/2): no prices — next: add them', icon: 'i-lucide-undo-2' })
  })
  it('the verdict panel', () => {
    expect(verificationView(null, 0)).toBeNull()
    expect(verificationView(v({ verdict: 'met', confidence: 0.92, outcome: 'finished' }), 1)).toMatchObject({ color: 'success', title: 'Verified: met (0.92) after 1 send-back' })
    expect(verificationView(v({ outcome: 'sent-back', sendBacks: 1 }), 1)).toMatchObject({ color: 'warning', title: 'Sent back 1 of 2 — verifier: partial (0.80)' })
    expect(verificationView(v({}), 2)).toMatchObject({ color: 'warning', title: '⚠ Finished unverified — verifier: partial (0.80) after 2 send-backs' })
    expect(verificationView(v({ verdict: null, error: 'x' }), 0)).toMatchObject({ title: '⚠ Finished unverified — the verifier could not check it' })
    expect(verificationView(v({ outcome: 'skipped', verdict: null }), 0)).toMatchObject({ color: 'neutral' })
  })
})
