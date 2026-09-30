import { describe, it, expect } from 'vitest'
import { parseReflectorOutput, type Proposal } from '../server/lib/agent/reflect/schema'
import { callReflector } from '../server/lib/agent/reflect/call'
import { threadReflectionMessages, jobsReflectionMessages } from '../server/lib/agent/reflect/prompt'

const THREAD: Proposal['kind'][] = ['skill.create', 'skill.edit', 'profile.edit']

const item = (over: Record<string, unknown> = {}) => ({
  kind: 'skill.create',
  target: 'deploy-check',
  content: '---\nname: deploy-check\n---\nsteps',
  reason: 'Worked out a reusable deploy check.',
  confidence: 0.7,
  evidence: ['check the health endpoint first'],
  ...over
})
const json = (items: unknown[]) => JSON.stringify({ proposals: items })

describe('parseReflectorOutput', () => {
  it('parses fenced JSON', () => {
    const r = parseReflectorOutput('```json\n' + json([item()]) + '\n```', THREAD)
    expect(r).toEqual({ ok: true, proposals: [item()] })
  })

  it('parses prose followed by JSON', () => {
    const r = parseReflectorOutput('Here is my review of the thread:\n\n' + json([item()]) + '\nThanks.', THREAD)
    expect(r.ok && r.proposals).toEqual([item()])
  })

  it('accepts a bare array', () => {
    const r = parseReflectorOutput(JSON.stringify([item()]), THREAD)
    expect(r.ok && r.proposals).toHaveLength(1)
  })

  it('repairs trailing commas', () => {
    const raw = '{"proposals": [{"kind": "skill.create", "target": "x", "reason": "r", "confidence": 0.5, "evidence": ["abc quote",],},]}'
    const r = parseReflectorOutput(raw, THREAD)
    expect(r.ok && r.proposals.map(p => p.target)).toEqual(['x'])
  })

  it('returns ok:false for unparsable input', () => {
    const r = parseReflectorOutput('{"proposals": [ this is not json at all', THREAD)
    expect(r.ok).toBe(false)
    expect(parseReflectorOutput('I think everything went fine.', THREAD).ok).toBe(false)
  })

  it('treats an empty proposals list, an empty reply and "none" as no proposals', () => {
    expect(parseReflectorOutput('{ "proposals": [] }', THREAD)).toEqual({ ok: true, proposals: [] })
    expect(parseReflectorOutput('   ', THREAD)).toEqual({ ok: true, proposals: [] })
    expect(parseReflectorOutput('None.', THREAD)).toEqual({ ok: true, proposals: [] })
  })

  it('keeps at most 3 of 5 valid items', () => {
    const r = parseReflectorOutput(json([1, 2, 3, 4, 5].map(n => item({ target: `t${n}` }))), THREAD)
    expect(r.ok && r.proposals.map(p => p.target)).toEqual(['t1', 't2', 't3'])
  })

  it('drops a kind outside the allowed set', () => {
    const r = parseReflectorOutput(json([item({ kind: 'job.disable', target: 'nightly' }), item()]), THREAD)
    expect(r.ok && r.proposals.map(p => p.kind)).toEqual(['skill.create'])
  })

  it('drops an item missing evidence', () => {
    const { evidence: _e, ...noEvidence } = item()
    const r = parseReflectorOutput(json([noEvidence, item({ target: 'kept', evidence: [] }), item({ target: 'ok' })]), THREAD)
    expect(r.ok && r.proposals.map(p => p.target)).toEqual(['ok'])
  })

  it('drops an item with confidence above 1', () => {
    const r = parseReflectorOutput(json([item({ confidence: 1.3 })]), THREAD)
    expect(r).toEqual({ ok: true, proposals: [] })
  })

  it('drops invalid items before applying the cap of 3', () => {
    const r = parseReflectorOutput(json([item({ confidence: 2 }), item({ target: 'a' }), item({ target: 'b' }), item({ target: 'c' })]), THREAD)
    expect(r.ok && r.proposals.map(p => p.target)).toEqual(['a', 'b', 'c'])
  })
})

describe('callReflector', () => {
  const msgs = threadReflectionMessages({ transcript: '[user] hi', skills: [], profile: '', recentRejections: [] })

  it('runs the reasoning model and passes its output through parseReflectorOutput', async () => {
    const calls: unknown[][] = []
    const chatFn = (async (...args: unknown[]) => { calls.push(args); return '```json\n' + json([item(), item({ kind: 'job.edit' })]) + '\n```' }) as never
    const r = await callReflector(msgs, THREAD, { chatFn })
    expect(r).toEqual({ ok: true, proposals: [item()] })
    expect(calls[0]![0]).toBe('reasoning')
    expect(calls[0]![1]).toBe(msgs)
    expect(calls[0]![2]).toEqual({ temperature: 0.2, maxTokens: 1500 })
  })

  it('returns ok:false instead of throwing when the model call fails', async () => {
    const chatFn = (async () => { throw new Error('chat: model returned no usable content') }) as never
    const r = await callReflector(msgs, THREAD, { chatFn })
    expect(r).toEqual({ ok: false, error: expect.stringContaining('no usable content') })
  })
})

describe('reflection prompts', () => {
  it('thread prompt carries the system rules, skills with their author, profile, rejections and transcript', () => {
    const m = threadReflectionMessages({
      transcript: '[user] remember I prefer tea',
      skills: [{ name: 'deploy-check', description: 'check deploys', source: 'agent' }, { name: 'triage', description: 'triage inbox', source: 'human' }],
      profile: 'Tony likes brevity.',
      recentRejections: ['skill.create deploy-notes']
    })
    expect(m[0]!.role).toBe('system')
    expect(m[0]!.content).toContain('Most threads warrant NONE, and an empty list is the right answer.')
    expect(m[0]!.content).toContain('Never propose tools, permissions, commands to run, or secrets.')
    const user = m[1]!.content as string
    expect(user).toContain('deploy-check')
    expect(user).toMatch(/deploy-check.*Bridget/)
    expect(user).toMatch(/triage.*Tony/)
    expect(user).toContain('Tony likes brevity.')
    expect(user).toContain('skill.create deploy-notes')
    expect(user).toContain('[user] remember I prefer tea')
  })

  it('jobs prompt lists each job with its signals and snippets', () => {
    const m = jobsReflectionMessages({ jobs: [{ slug: 'morning-brief', content: '---\ntrigger: cron 0 7 * * *\n---\nbrief', source: 'agent', signals: { ignored: 6, replied: 1 }, snippets: ['stop sending these'] }] })
    expect(m[0]!.content).toContain('job.disable')
    const user = m[1]!.content as string
    expect(user).toContain('morning-brief')
    expect(user).toContain('ignored: 6')
    expect(user).toContain('stop sending these')
  })
})
