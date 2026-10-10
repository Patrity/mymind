// test/channels-approval-text.test.ts
// The iMessage approval question, worded per tool (cycle 76 final review m1; gmail_send branch
// added cycle 79 review I3).
import { describe, it, expect } from 'vitest'
import { approvalPromptText, PROMPT_COMMAND_MAX, GMAIL_SEND_PROMPT_MAX, CALENDAR_PROMPT_MAX, TITLED_PROMPT_MAX } from '@mymind/core/lib/channels/approvals'

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

  it('gmail_send (fix wave I2): a command past GMAIL_SEND_PROMPT_MAX is cut and says "showing N of M chars — open the draft"', () => {
    const command = 'x'.repeat(GMAIL_SEND_PROMPT_MAX + 2410)
    const text = approvalPromptText({ tool: 'gmail_send', command, proposedPattern: '' })
    expect(text).toContain(`${'x'.repeat(GMAIL_SEND_PROMPT_MAX)}…\n[showing 1,800 of 4,210 chars — open the draft in Gmail before approving]`)
    expect(text).not.toContain('x'.repeat(GMAIL_SEND_PROMPT_MAX + 1))
  })

  it('gmail_send: a command within the cap carries no truncation notice', () => {
    const text = approvalPromptText({ tool: 'gmail_send', command: 'x'.repeat(GMAIL_SEND_PROMPT_MAX), proposedPattern: '' })
    expect(text).not.toContain('showing')
  })

  it('calendar_guest_event / calendar_rsvp (Task 5): their own card title over the multi-line card, no backticks, exempt from PROMPT_COMMAND_MAX', () => {
    const command = 'Create an event in work — Google emails the invites\nTitle: Lunch\nWhen: Thu, Oct 8, 12:00 PM CDT – Thu, Oct 8, 1:00 PM CDT\nGuests: ' + 'a@b.com, '.repeat(60)
    const guest = approvalPromptText({ tool: 'calendar_guest_event', title: 'Invite guests?', command, proposedPattern: '' })
    expect(guest).toBe(`Invite guests?\n\n${command}\n\n👍 to approve · 👎 to deny`)
    expect(command.length).toBeGreaterThan(PROMPT_COMMAND_MAX)
    expect(guest).not.toContain('`')
    expect(guest).not.toContain('Allow calendar_guest_event')
    const rsvp = approvalPromptText({ tool: 'calendar_rsvp', title: 'Send RSVP?', command: 'RSVP "declined" to "Offsite" (work)', proposedPattern: '' })
    expect(rsvp.startsWith('Send RSVP?\n\nRSVP "declined"')).toBe(true)
  })

  it('calendar (fix wave I2): a command past CALENDAR_PROMPT_MAX is cut and says "showing N of M chars"', () => {
    const text = approvalPromptText({ tool: 'calendar_guest_event', title: 'Invite guests?', command: 'x'.repeat(CALENDAR_PROMPT_MAX + 40), proposedPattern: '' })
    expect(text).toContain(`${'x'.repeat(CALENDAR_PROMPT_MAX)}…\n[showing 1,500 of 1,540 chars — open the event in Google Calendar before approving]`)
  })

  it('fix wave I3: a titled outbound card (web_fetch after a Google read) texts its heading + the exact URL, no backticks', () => {
    const command = 'web_fetch — Bridget read your Google mail…\n\nurl: https://x.example/?d=1'
    const text = approvalPromptText({ tool: 'web_fetch', title: 'Web request after reading your mail', command, proposedPattern: '', allowlistable: false })
    expect(text).toBe(`Web request after reading your mail?\n\n${command}\n\n👍 to approve · 👎 to deny`)
    expect(text).not.toContain('`')
  })

  it('79b: a background-work card (create_job after a Google read) texts its own heading + the job markdown', () => {
    const command = 'create_job — Bridget read your Google mail…\n\nslug: x\ncontent: ---\ntrigger: every 1h\n---\nbody'
    const text = approvalPromptText({ tool: 'create_job', title: 'Background work after reading your mail', command, proposedPattern: '', allowlistable: false })
    expect(text).toBe(`Background work after reading your mail?\n\n${command}\n\n👍 to approve · 👎 to deny`)
  })

  it('79b I2: exec in a tainted run says so before the command', () => {
    const text = approvalPromptText({ tool: 'exec', title: 'Command after reading your mail', command: 'curl https://x.example', proposedPattern: '', allowlistable: false })
    expect(text).toBe('Command after reading your mail — run `curl https://x.example`?\n👍 to approve · 👎 to deny')
  })

  it('fix wave I3: a long outbound card is cut with the "showing N of M chars" notice', () => {
    const text = approvalPromptText({ tool: 'research_web', title: 'Web request after reading your mail', command: 'y'.repeat(TITLED_PROMPT_MAX + 10), proposedPattern: '' })
    expect(text).toContain(`[showing 1,500 of 1,510 chars — deny unless you can see the whole request]`)
  })
})
