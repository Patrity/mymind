import { describe, it, expect } from 'vitest'
import { sameScoringSpec, scoringSpecOf } from './scoring-spec'

const row = {
  expectedActions: [{ tool: 'create_task', args: { a: 1, b: { c: 2, d: 3 } }, args_pattern: { title: 'x' } }],
  forbiddenActions: [{ tool: 'delete_task' }], expectedContent: ['ok'], matchMode: 'ordered_subset', countFailed: false,
  expectedApprovals: [], forbiddenApprovals: [{ tool: 'exec' }], expectFlagged: false, expectTainted: true, rubric: 'r'
}

describe('scoring spec snapshot', () => {
  it('captures every scoring input under its case-JSON name', () => {
    expect(scoringSpecOf(row)).toEqual({
      expected_actions: row.expectedActions, forbidden_actions: row.forbiddenActions, expected_content: ['ok'], match_mode: 'ordered_subset',
      count_failed: false, expected_approvals: [], forbidden_approvals: [{ tool: 'exec' }], expect_flagged: false, expect_tainted: true, rubric: 'r'
    })
  })
  it('equality ignores key order at any depth but not array order or values', () => {
    const a = scoringSpecOf(row)
    const b = scoringSpecOf({ ...row, expectedActions: [{ args_pattern: { title: 'x' }, args: { b: { d: 3, c: 2 }, a: 1 }, tool: 'create_task' }] })
    expect(sameScoringSpec(a, b)).toBe(true)
    expect(sameScoringSpec(a, scoringSpecOf({ ...row, expectedActions: [{ tool: 'create_task', args: { a: 2, b: { c: 2, d: 3 } }, args_pattern: { title: 'x' } }] }))).toBe(false)
    expect(sameScoringSpec(a, scoringSpecOf({ ...row, expectedContent: ['ok', 'more'] }))).toBe(false)
    expect(sameScoringSpec(a, scoringSpecOf({ ...row, matchMode: 'subset' }))).toBe(false)
    expect(sameScoringSpec(a, scoringSpecOf({ ...row, rubric: null }))).toBe(false)
    expect(sameScoringSpec(a, scoringSpecOf({ ...row, forbiddenApprovals: [] }))).toBe(false)
  })
})
