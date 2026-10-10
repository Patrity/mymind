import { describe, it, expect, vi } from 'vitest'
import { jevCheck, JEV_BUMP, REFLECT_JEV_QUESTIONS } from '@mymind/core/lib/agent/reflect/jev'
import type { JevConfig, JevResponse } from '@mymind/core/lib/ai/jev'
import type { Proposal } from '@mymind/core/lib/agent/reflect/schema'

const cfg: JevConfig = { baseURL: 'http://jev.invalid', apiKey: 'k', model: 'jev-latest' }
const skill: Proposal = { kind: 'skill.create', target: 'file-receipts', content: '# File receipts', reason: 'Tony corrected it', confidence: 0.8, evidence: ['always file receipts'] }

function answering(values: Record<string, number>, model = 'jev-1.13.0') {
  return vi.fn(async (): Promise<JevResponse> => ({
    model,
    answers: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { type: 'noul' as const, noul: v }]))
  }))
}

describe('REFLECT_JEV_QUESTIONS', () => {
  it('asks the observable questions per kind, unwanted high', () => {
    expect(Object.keys(REFLECT_JEV_QUESTIONS.skill)).toEqual(['one_off', 'time_bound'])
    expect(Object.keys(REFLECT_JEV_QUESTIONS.profile)).toEqual(['inferred', 'passing'])
    expect(Object.keys(REFLECT_JEV_QUESTIONS.job)).toEqual(['unrelated'])
    for (const qs of Object.values(REFLECT_JEV_QUESTIONS)) {
      for (const q of Object.values(qs)) {
        expect(q.type).toBe('noul')
        expect(q.unwanted).toBe('high')
      }
    }
    expect(JEV_BUMP).toBe(0.6)
  })
})

describe('jevCheck', () => {
  it('0.7 on an unwanted-high question → risky', async () => {
    const ask = answering({ one_off: 0.7, time_bound: 0.1 })
    expect(await jevCheck(skill, { ask, cfg })).toEqual({ answers: { one_off: 0.7, time_bound: 0.1 }, risky: true, model: 'jev-1.13.0' })
  })
  it('exactly the bump threshold is risky', async () => {
    const v = await jevCheck(skill, { ask: answering({ one_off: 0.1, time_bound: 0.6 }), cfg })
    expect(v !== 'unavailable' && v.risky).toBe(true)
  })
  it('all low → not risky', async () => {
    const v = await jevCheck(skill, { ask: answering({ one_off: 0.2, time_bound: 0.59 }), cfg })
    expect(v).toEqual({ answers: { one_off: 0.2, time_bound: 0.59 }, risky: false, model: 'jev-1.13.0' })
  })
  it('cfg: null → unavailable, without asking', async () => {
    const ask = answering({})
    expect(await jevCheck(skill, { ask, cfg: null })).toBe('unavailable')
    expect(ask).not.toHaveBeenCalled()
  })
  it('ask throws → unavailable', async () => {
    const ask = vi.fn(async () => { throw new Error('Jev 500') })
    expect(await jevCheck(skill, { ask, cfg })).toBe('unavailable')
  })
  it('a missing answer → unavailable (never read as safe)', async () => {
    expect(await jevCheck(skill, { ask: answering({ one_off: 0.1 }), cfg })).toBe('unavailable')
  })
  it('asks the kind\'s questions (without the unwanted flag) over kind, target, content, reason and the proposal\'s evidence quotes', async () => {
    const ask = answering({ inferred: 0.1, passing: 0.1 })
    const profile: Proposal = { kind: 'profile.edit', target: 'profile', content: 'Prefers mornings.', reason: 'He said so', confidence: 0.9, evidence: ['I prefer mornings', 'mornings are best for me'] }
    await jevCheck(profile, { ask, cfg })
    const [state, questions, usedCfg] = ask.mock.calls[0] as unknown as [string, Record<string, unknown>, JevConfig]
    expect(state).toBe('profile.edit\n\nprofile\n\nPrefers mornings.\n\nHe said so\n\nI prefer mornings\nmornings are best for me')
    expect(questions).toEqual({
      inferred: { type: 'noul', instructions: REFLECT_JEV_QUESTIONS.profile.inferred!.instructions },
      passing: { type: 'noul', instructions: REFLECT_JEV_QUESTIONS.profile.passing!.instructions }
    })
    expect(usedCfg).toBe(cfg)
  })
  it('job kinds use the job question', async () => {
    const ask = answering({ unrelated: 0.9 })
    const v = await jevCheck({ ...skill, kind: 'job.disable', target: 'heartbeat', content: undefined }, { ask, cfg })
    expect(v !== 'unavailable' && v.risky).toBe(true)
    expect(Object.keys(ask.mock.calls[0]![1] as object)).toEqual(['unrelated'])
    expect((ask.mock.calls[0] as unknown as [string])[0]).toBe('job.disable\n\nheartbeat\n\nTony corrected it\n\nalways file receipts')
  })
})
