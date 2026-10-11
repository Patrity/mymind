import { describe, it, expect } from 'vitest'
import { BUDGET_LIMITS, DEFAULT_WORKSTREAM_BUDGET, RESUME_EXTENSION, ZERO_USED } from '@mymind/core/shared/types/workstreams'
import {
  BUDGET_NOTES, canCancel, canResume, elapsedMs, eventDisplay, formatCost, formatDuration, resumeAdds, resumeLabel, startedWorkstream
} from './display'

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
    expect(startedWorkstream('create_task', {}, { ok: true, id: ID })).toBeNull()
    expect(startedWorkstream('start_workstream', {}, { ok: true, id: 'javascript:x' })).toBeNull()
    expect(startedWorkstream('start_workstream', {}, 'not json')).toBeNull()
  })
})
