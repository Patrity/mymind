// Cycle 84 Task 1 — the Smart Approvals predicate, as a full truth table against an oracle written
// straight from the global constraint:
//   settings.judge.enabled ∧ surfaceEnabled ∧ verdict.recommendation==='approve'
//   ∧ verdict.confidence ≥ settings.judge.confidence ∧ !verdict.error ∧ ruleFloor ∉ {high, critical, deny}
//   ∧ !(tool.outbound ∧ runTainted) ∧ nonce unchanged ∧ verdict.risk ∈ {low, medium} ∧ !verdict.lenient;
//   headless never.  (risk/lenient: fix round 1 rulings.)
import { describe, it, expect } from 'vitest'
import { autoApprovePredicate, autoApproveBlocker, type AutoApproveInput } from './auto-approve'
import { RULE_FLOORS, type ApprovalSurface, type JudgeSettings, type JudgeVerdict } from './types'

const base: Omit<JudgeVerdict, 'recommendation' | 'confidence'> = { risk: 'low', reasons: ['r'], model: 'J', latencyMs: 10 }
const VERDICTS: Array<[string, JudgeVerdict | null]> = [
  ['none', null],
  ['approve 0.95', { ...base, recommendation: 'approve', confidence: 0.95 }],
  ['approve 0.90', { ...base, recommendation: 'approve', confidence: 0.9 }],
  ['approve 0.89', { ...base, recommendation: 'approve', confidence: 0.89 }],
  ['approve 0.99 + error', { ...base, recommendation: 'approve', confidence: 0.99, error: 'timeout' }],
  ['approve 0.99 medium risk', { ...base, risk: 'medium', recommendation: 'approve', confidence: 0.99 }],
  ['approve 0.99 high risk', { ...base, risk: 'high', recommendation: 'approve', confidence: 0.99 }],
  ['approve 0.99 lenient', { ...base, recommendation: 'approve', confidence: 0.99, lenient: true }],
  ['review 0.99', { ...base, recommendation: 'review', confidence: 0.99 }],
  ['deny 0.99', { ...base, recommendation: 'deny', confidence: 0.99 }]
]
const SURFACES: ApprovalSurface[] = ['workstream', 'chat', 'headless']
const B = [false, true]

function oracle(i: AutoApproveInput): boolean {
  const s = i.settings
  const surfaceEnabled = i.surface === 'workstream' ? s.smartApprovals.workstreams : i.surface === 'chat' ? s.smartApprovals.chat : false
  const v = i.verdict
  return s.enabled && surfaceEnabled && !!v && v.recommendation === 'approve' && v.confidence >= s.confidence
    && !v.error && !v.lenient && (v.risk === 'low' || v.risk === 'medium') && i.ruleFloor !== 'high' && i.ruleFloor !== 'critical' && i.ruleFloor !== 'deny' && !(i.outbound && i.runTainted) && i.nonceUnchanged
}

function* allInputs(): Generator<[string, AutoApproveInput]> {
  for (const enabled of B) for (const workstreams of B) for (const chat of B) for (const confidence of [0.9, 0.95]) {
    const settings: JudgeSettings = { enabled, smartApprovals: { workstreams, chat }, confidence }
    for (const surface of SURFACES) for (const [vName, verdict] of VERDICTS) for (const ruleFloor of RULE_FLOORS)
      for (const outbound of B) for (const runTainted of B) for (const nonceUnchanged of B) {
        const name = `enabled=${enabled} ws=${workstreams} chat=${chat} conf≥${confidence} ${surface} verdict=${vName} floor=${ruleFloor} outbound=${outbound} tainted=${runTainted} nonceOk=${nonceUnchanged}`
        yield [name, { settings, surface, verdict, ruleFloor, outbound, runTainted, nonceUnchanged }]
      }
  }
}

describe('autoApprovePredicate — full truth table', () => {
  const rows = [...allInputs()]

  it('covers every combination (2·2·2·2 settings × 3 surfaces × 10 verdicts × 5 floors × 2·2·2)', () => {
    expect(rows).toHaveLength(16 * 3 * 10 * 5 * 8)
  })

  it('matches the spec formula on every row', () => {
    const wrong = rows.filter(([, i]) => autoApprovePredicate(i) !== oracle(i)).map(([n]) => n)
    expect(wrong).toEqual([])
  })

  it('is not vacuous: some rows auto-approve, most do not', () => {
    const yes = rows.filter(([, i]) => autoApprovePredicate(i)).length
    expect(yes).toBeGreaterThan(0)
    expect(yes).toBeLessThan(rows.length / 10)
  })
})

describe('autoApprovePredicate — each exclusion on its own (spec §2.4)', () => {
  const ok: AutoApproveInput = {
    settings: { enabled: true, smartApprovals: { workstreams: true, chat: false }, confidence: 0.9 },
    surface: 'workstream', verdict: { ...base, recommendation: 'approve', confidence: 0.94 },
    ruleFloor: 'review', outbound: false, runTainted: false, nonceUnchanged: true
  }

  it('the baseline auto-approves', () => {
    expect(autoApproveBlocker(ok)).toBeNull()
    expect(autoApprovePredicate(ok)).toBe(true)
  })

  it.each<[string, Partial<AutoApproveInput>, string]>([
    ['judge disabled', { settings: { ...ok.settings, enabled: false } }, 'judge-disabled'],
    ['workstream Smart Approvals off', { settings: { ...ok.settings, smartApprovals: { workstreams: false, chat: true } } }, 'surface-disabled'],
    ['chat (default off)', { surface: 'chat' }, 'surface-disabled'],
    ['headless, even with every surface on', { surface: 'headless', settings: { ...ok.settings, smartApprovals: { workstreams: true, chat: true } } }, 'surface-disabled'],
    ['nonce changed', { nonceUnchanged: false }, 'nonce-changed'],
    ['rule floor high (spec D6: no rule flag)', { ruleFloor: 'high' }, 'rule-floor'],
    ['rule floor critical', { ruleFloor: 'critical' }, 'rule-floor'],
    ['rule floor deny', { ruleFloor: 'deny' }, 'rule-floor'],
    ['outbound in a tainted run', { outbound: true, runTainted: true }, 'tainted-outbound'],
    ['no verdict yet', { verdict: null }, 'no-verdict'],
    ['judge error / timeout', { verdict: { ...base, recommendation: 'approve', confidence: 0.99, error: 'judge timed out' } }, 'verdict-error'],
    ['judge error with an empty message', { verdict: { ...base, recommendation: 'approve', confidence: 0.99, error: '' } }, 'verdict-error'],
    ['recommendation review', { verdict: { ...base, recommendation: 'review', confidence: 0.99 } }, 'not-approve'],
    ['recommendation deny', { verdict: { ...base, recommendation: 'deny', confidence: 0.99 } }, 'not-approve'],
    ['confidence below the threshold', { verdict: { ...base, recommendation: 'approve', confidence: 0.899 } }, 'low-confidence'],
    ['confidence NaN', { verdict: { ...base, recommendation: 'approve', confidence: Number.NaN } }, 'low-confidence'],
    ['confidence over 1', { verdict: { ...base, recommendation: 'approve', confidence: 5 } }, 'low-confidence'],
    ['a stored threshold below the floor is read as 0.5', { settings: { ...ok.settings, confidence: 0.1 }, verdict: { ...base, recommendation: 'approve', confidence: 0.4 } }, 'low-confidence'],
    ['a NaN stored threshold blocks', { settings: { ...ok.settings, confidence: Number.NaN } }, 'low-confidence'],
    ['approve at high risk', { verdict: { ...base, risk: 'high', recommendation: 'approve', confidence: 0.99 } }, 'risk-too-high'],
    ['approve at critical risk', { verdict: { ...base, risk: 'critical', recommendation: 'approve', confidence: 0.99 } }, 'risk-too-high'],
    ['approve with no risk', { verdict: { ...base, risk: null, recommendation: 'approve', confidence: 0.99 } }, 'risk-too-high'],
    ['a lenient (text-fallback) verdict', { verdict: { ...base, recommendation: 'approve', confidence: 0.99, lenient: true } }, 'lenient-verdict'],
    ['an unknown rule floor', { ruleFloor: 'weird' as never }, 'rule-floor'],
    ['an undefined rule floor', { ruleFloor: undefined as never }, 'rule-floor'],
    ['outbound undefined in a tainted run', { outbound: undefined as never, runTainted: true }, 'tainted-outbound'],
    ['tainted undefined on an outbound call', { outbound: true, runTainted: undefined as never }, 'tainted-outbound'],
    ['both undefined', { outbound: undefined as never, runTainted: undefined as never }, 'tainted-outbound'],
    ['nonceUnchanged undefined', { nonceUnchanged: undefined as never }, 'nonce-changed'],
    ['smartApprovals missing', { settings: { enabled: true, confidence: 0.9 } as never }, 'surface-disabled'],
    ['settings missing', { settings: undefined as never }, 'judge-disabled'],
    ['enabled a truthy non-boolean', { settings: { ...ok.settings, enabled: 'yes' as never } }, 'judge-disabled'],
    ['confidence a numeric string', { verdict: { ...base, recommendation: 'approve', confidence: '0.99' as never } }, 'low-confidence']
  ])('%s → never auto', (_name, patch, blocker) => {
    const i = { ...ok, ...patch }
    expect(autoApproveBlocker(i)).toBe(blocker)
    expect(autoApprovePredicate(i)).toBe(false)
  })

  it('chat auto-approves once Tony turns chat on', () => {
    expect(autoApprovePredicate({ ...ok, surface: 'chat', settings: { ...ok.settings, smartApprovals: { workstreams: false, chat: true } } })).toBe(true)
  })

  it('a medium-risk approve stays auto-approvable', () => {
    expect(autoApprovePredicate({ ...ok, verdict: { ...base, risk: 'medium', recommendation: 'approve', confidence: 0.95 } })).toBe(true)
  })

  it('a missing input object never throws and never approves', () => {
    expect(autoApprovePredicate(undefined as never)).toBe(false)
  })

  it('outbound in an untainted run, a tainted non-outbound call and a low floor stay auto-approvable', () => {
    expect(autoApprovePredicate({ ...ok, outbound: true })).toBe(true)
    expect(autoApprovePredicate({ ...ok, runTainted: true })).toBe(true)
    expect(autoApprovePredicate({ ...ok, ruleFloor: 'low' })).toBe(true)
  })
})
