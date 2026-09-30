import { describe, it, expect } from 'vitest'
import { parseReflectorOutput, type Proposal } from '../server/lib/agent/reflect/schema'
import { callReflector } from '../server/lib/agent/reflect/call'
import { threadReflectionMessages, jobsReflectionMessages, skillFilesForPrompt, SKILL_FILE_SHOWN_MAX, SKILL_FILES_TOTAL_MAX } from '../server/lib/agent/reflect/prompt'

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

  it('returns ok:false, without throwing, for a closed but invalid JSON block', () => {
    let r: ReturnType<typeof parseReflectorOutput> | undefined
    expect(() => { r = parseReflectorOutput('{"proposals": [oops]}', THREAD) }).not.toThrow()
    expect(r).toEqual({ ok: false, error: expect.stringContaining('not valid JSON') })
  })

  it('leaves code fences inside JSON strings intact, fenced or not', () => {
    const p = item({
      content: '---\nname: deploy-check\n---\nRun:\n```bash\nls -la\n```\ndone',
      evidence: ['use ```ls``` first', 'then `pwd`']
    })
    expect(parseReflectorOutput(json([p]), THREAD)).toEqual({ ok: true, proposals: [p] })
    expect(parseReflectorOutput('```json\n' + json([p]) + '\n```', THREAD)).toEqual({ ok: true, proposals: [p] })
    expect(parseReflectorOutput('Here you go:\n```json\n' + json([p]) + '\n```', THREAD)).toEqual({ ok: true, proposals: [p] })
  })

  it('skips brackets in prose that are not the reply', () => {
    const r = parseReflectorOutput('Per the [user] request (see [1]):\n' + json([item()]), THREAD)
    expect(r).toEqual({ ok: true, proposals: [item()] })
  })

  it('repairs trailing commas only outside strings', () => {
    const raw = '{"proposals": [{"kind": "skill.create", "target": "x", "reason": "keep ,] and ,} here", "confidence": 0.5, "evidence": ["quote with , ] inside",],},]}'
    const r = parseReflectorOutput(raw, THREAD)
    expect(r.ok && r.proposals[0]!.reason).toBe('keep ,] and ,} here')
    expect(r.ok && r.proposals[0]!.evidence).toEqual(['quote with , ] inside'])
  })

  it('treats an empty proposals list, an empty reply and "none" as no proposals', () => {
    expect(parseReflectorOutput('{ "proposals": [] }', THREAD)).toEqual({ ok: true, proposals: [] })
    expect(parseReflectorOutput('   ', THREAD)).toEqual({ ok: true, proposals: [] })
    expect(parseReflectorOutput('None.', THREAD)).toEqual({ ok: true, proposals: [] })
    // The fence strip is what makes a fenced "none" or an empty fence readable.
    expect(parseReflectorOutput('```\nnone\n```', THREAD)).toEqual({ ok: true, proposals: [] })
    expect(parseReflectorOutput('```json\n```', THREAD)).toEqual({ ok: true, proposals: [] })
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
    expect(m[0]!.content).toContain('at most 4 KB')
    expect(m[0]!.content).toContain('at most 1,500 tokens')
    const user = m[1]!.content as string
    expect(user).toContain('deploy-check')
    expect(user).toMatch(/deploy-check.*Bridget/)
    expect(user).toMatch(/triage.*Tony/)
    expect(user).toContain('Tony likes brevity.')
    expect(user).toContain('skill.create deploy-notes')
    expect(user).toContain('[user] remember I prefer tea')
  })

  it('thread prompt shows active skill files within 2 KB each / 16 KB total; the rest by name only', () => {
    const file = (name: string, kb: number) => `---\nname: ${name}\n---\n` + 'x'.repeat(kb * 1024)
    const skills = [
      { name: 'small', description: 'd', source: 'agent' as const, active: true, content: file('small', 1) },
      { name: 'inactive', description: 'd', source: 'agent' as const, active: false, content: file('inactive', 1) },
      { name: 'big', description: 'd', source: 'human' as const, active: true, content: file('big', 5) },
      ...Array.from({ length: 8 }, (_, i) => ({ name: `fill-${i}`, description: 'd', source: 'agent' as const, active: true, content: file(`fill-${i}`, 1.9) }))
    ]
    const shown = skillFilesForPrompt(skills)
    expect(shown.get('small')).toMatchObject({ full: true })
    expect(shown.has('inactive')).toBe(false)
    // Over 2 KB: cut to 2 KB with a marker, and NOT full (an edit of it would be blind).
    expect(shown.get('big')!.full).toBe(false)
    expect(Buffer.byteLength(shown.get('big')!.text)).toBeLessThanOrEqual(SKILL_FILE_SHOWN_MAX)
    expect(shown.get('big')!.text).toContain('[… truncated]')
    // The 16 KB total holds small (~1 KB) + big (2 KB) + six ~1.9 KB fills; the last two don't fit.
    const total = [...shown.values()].reduce((n, f) => n + Buffer.byteLength(f.text), 0)
    expect(total).toBeLessThanOrEqual(SKILL_FILES_TOTAL_MAX)
    expect([...shown.keys()]).toEqual(['small', 'big', 'fill-0', 'fill-1', 'fill-2', 'fill-3', 'fill-4', 'fill-5'])

    const user = threadReflectionMessages({ transcript: 't', skills, profile: '', recentRejections: [] })[1]!.content as string
    expect(user).toContain('### small\n---\nname: small')
    expect(user).toContain('### big (truncated — cannot be edited)')
    expect(user).not.toContain('### fill-6')
    expect(user).toContain('- fill-6 (authored by Bridget): d') // still listed by name
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
