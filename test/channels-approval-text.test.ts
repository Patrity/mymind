// test/channels-approval-text.test.ts
// The iMessage approval question, worded per tool (cycle 76 final review m1).
import { describe, it, expect } from 'vitest'
import { approvalPromptText, PROMPT_COMMAND_MAX } from '../server/lib/channels/approvals'

const FOOT = '\n👍 to approve · 👎 to deny'

describe('approvalPromptText', () => {
  it('exec asks to run the command, as before', () => {
    expect(approvalPromptText({ tool: 'exec', command: 'ls -la /tmp', proposedPattern: 'ls *' })).toBe(`Run \`ls -la /tmp\`?${FOOT}`)
  })

  it('decide_review reads as a review decision, not a command', () => {
    const text = approvalPromptText({ tool: 'decide_review', command: 'approve — skill.create filing-receipts', proposedPattern: '' })
    expect(text).toBe(`Approve review decision: approve — skill.create filing-receipts?${FOOT}`)
    expect(text).not.toContain('Run')
  })

  it('any other dangerous tool names itself', () => {
    expect(approvalPromptText({ tool: 'delete_everything', command: '{"id":"x"}', proposedPattern: '' })).toBe(`Allow delete_everything: \`{"id":"x"}\`?${FOOT}`)
  })

  it('a long command is cut to PROMPT_COMMAND_MAX characters', () => {
    const text = approvalPromptText({ tool: 'decide_review', command: 'x'.repeat(PROMPT_COMMAND_MAX + 50), proposedPattern: '' })
    expect(text).toContain(`${'x'.repeat(PROMPT_COMMAND_MAX - 1)}…?`)
  })
})
