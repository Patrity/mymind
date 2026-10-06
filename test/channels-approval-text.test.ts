// test/channels-approval-text.test.ts
// The iMessage approval question, worded per tool (cycle 76 final review m1; gmail_send branch
// added cycle 79 review I3).
import { describe, it, expect } from 'vitest'
import { approvalPromptText, PROMPT_COMMAND_MAX, GMAIL_SEND_PROMPT_MAX } from '../server/lib/channels/approvals'

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

  it('gmail_send (I3): "Send this email?" over the exact command, no backticks, exempt from PROMPT_COMMAND_MAX', () => {
    const command = 'From: tony@work.com\nTo: ann@a.com\n\n' + 'x'.repeat(PROMPT_COMMAND_MAX + 50)
    const text = approvalPromptText({ tool: 'gmail_send', command, proposedPattern: '' })
    expect(text).toBe(`Send this email?\n\n${command}\n\n👍 to send · 👎 to deny`)
    expect(text).not.toContain('`')
    expect(text).not.toContain('Allow gmail_send')
  })

  it('gmail_send: a command past GMAIL_SEND_PROMPT_MAX is cut with a "how many more chars" note, pointing at Gmail', () => {
    const command = 'x'.repeat(GMAIL_SEND_PROMPT_MAX + 230)
    const text = approvalPromptText({ tool: 'gmail_send', command, proposedPattern: '' })
    expect(text).toContain(`${'x'.repeat(GMAIL_SEND_PROMPT_MAX)}… [230 more chars — open the draft in Gmail]`)
  })
})
