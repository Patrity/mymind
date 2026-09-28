/**
 * Starter markdown for the /jobs "New job" modal (cycle 74). Each one is a complete job file that
 * passes the server parser (server/lib/agent/jobs/parse.ts — pinned by templates.test.ts) and
 * starts DISABLED: a new job never fires until Tony turns it on.
 */
export type JobTemplateId = 'morning-brief' | 'heartbeat' | 'event-digest' | 'blank'

export interface JobTemplate {
  id: JobTemplateId
  label: string
  description: string
  content: string
}

export const JOB_TEMPLATES: readonly JobTemplate[] = [
  {
    id: 'morning-brief',
    label: 'Morning brief',
    description: 'Weekdays at 7:30 — what is due, what changed, what is waiting.',
    content: `---
trigger: cron 30 7 * * 1-5
context: light
deliver: [auto]
enabled: false
---
Give Tony a morning brief: what's due today and overdue, what changed overnight,
captures waiting in triage, anything stale for 3+ days. Under 10 lines.
If nothing matters, reply NO_REPLY.
`
  },
  {
    id: 'heartbeat',
    label: 'Heartbeat',
    description: 'Every 30 minutes in waking hours — speaks only when something needs attention.',
    content: `---
trigger: every 30m
active_hours: 08:00-22:00
context: light
deliver: [auto]
enabled: false
---
Check in on:
- overdue tasks
- new captures
- pending /review items
- failed jobs

Reply NO_REPLY if nothing merits attention.
`
  },
  {
    id: 'event-digest',
    label: 'Event digest',
    description: 'When a Claude Code session ends — a short digest of what happened.',
    content: `---
trigger: event cc.session_end
thread: main
context: light
deliver: [app]
enabled: false
---
Write a 3-6 line digest of the Claude Code session that just ended: what was done,
what was deferred, anything that looks stuck. Reply NO_REPLY if the session was trivial.
`
  },
  {
    id: 'blank',
    label: 'Blank',
    description: 'A daily job to fill in yourself.',
    content: `---
trigger: cron 0 9 * * *
deliver: [auto]
enabled: false
---
Describe what the agent should do when this job fires.
Reply NO_REPLY when there is nothing worth saying.
`
  }
] as const

export function jobTemplate(id: JobTemplateId): JobTemplate {
  return JOB_TEMPLATES.find(t => t.id === id) ?? JOB_TEMPLATES[JOB_TEMPLATES.length - 1]!
}

/** Mirrors server/lib/agent/jobs/store.ts JOB_SLUG_RE (pinned equal by templates.test.ts). */
export const JOB_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
