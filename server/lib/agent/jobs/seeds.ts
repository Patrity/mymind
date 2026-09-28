// server/lib/agent/jobs/seeds.ts
// The four seed jobs (spec §8): morning-brief, evening-wrap, heartbeat, session-digest.
// Installed by store.ts's installSeedJobs, always DISABLED (`enabled: false`) — Tony turns
// them on from /jobs. Held as template strings, not built from JobSpec/joinFrontmatter, so the
// exact frontmatter/body byte layout here is what a fresh install writes, verbatim.
export const SEED_JOB_SLUGS = ['morning-brief', 'evening-wrap', 'heartbeat', 'session-digest'] as const
export type SeedJobSlug = (typeof SEED_JOB_SLUGS)[number]

export const SEED_JOBS: Record<SeedJobSlug, string> = {
  'morning-brief': `---
trigger: cron 30 7 * * 1-5
enabled: false
---
Give Tony a morning brief: what's due today and overdue, what changed overnight,
captures waiting in triage, anything stale for 3+ days. Under 10 lines.
If nothing matters, reply NO_REPLY.
`,

  'evening-wrap': `---
trigger: cron 0 21 * * *
enabled: false
---
Give Tony an evening wrap: what got done today, what's still open, anything due
first thing tomorrow. Under 10 lines.
If nothing happened today, reply NO_REPLY.
`,

  'heartbeat': `---
trigger: every 30m
active_hours: 08:00-22:00
context: light
enabled: false
---
Check in on:
- overdue tasks
- new captures
- pending /review items
- failed jobs
- anything Tony asked to be reminded about

Reply NO_REPLY if nothing merits attention.
`,

  'session-digest': `---
trigger: event cc.session_end
thread: main
context: light
enabled: false
---
Write a 3-6 line digest of the Claude Code session that just ended: what was done,
what was deferred, anything that looks stuck. Propose tasks rather than creating
duplicates. Reply NO_REPLY if the session was trivial.
`
}
