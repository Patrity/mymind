// server/lib/agent/jobs/seeds.ts
// The seed jobs (spec §8): morning-brief, evening-wrap, heartbeat, session-digest, plus
// self-improvement-digest (cycle 76, Task 10). Installed by store.ts's installSeedJobs, always
// DISABLED (`enabled: false`) — Tony turns them on from /jobs. Held as template strings, not
// built from JobSpec/joinFrontmatter, so the exact frontmatter/body byte layout here is what a
// fresh install writes, verbatim.
//
// Cycle 75 added a `deliver:` line to each of the original four. SEED_JOBS_V1 is the cycle-74
// content, byte for byte (commit 6b7110c): store.ts's upgradeSeedJobs moves a seed to SEED_JOBS
// only while its stored content still hashes the same as its V1 string, so a seed Tony edited is
// never touched. self-improvement-digest was born with its `deliver:` line already in place — it
// has no V1 predecessor, so it is NOT in SEED_JOBS_V1 (a distinct, narrower slug union) and
// upgradeSeedJobs never touches it; installSeedJobs is its only install path.
export const SEED_JOB_SLUGS = ['morning-brief', 'evening-wrap', 'heartbeat', 'session-digest', 'self-improvement-digest'] as const
export type SeedJobSlug = (typeof SEED_JOB_SLUGS)[number]

export const SEED_JOBS: Record<SeedJobSlug, string> = {
  'morning-brief': `---
trigger: cron 30 7 * * 1-5
context: light
deliver: [auto, imessage]
enabled: false
---
Give Tony a morning brief: what's due today and overdue, what changed overnight,
captures waiting in triage, anything stale for 3+ days. Under 10 lines.
If nothing matters, reply NO_REPLY.
`,

  'evening-wrap': `---
trigger: cron 0 21 * * *
context: light
deliver: [auto]
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
deliver: [auto]
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
deliver: [app]
enabled: false
---
Write a 3-6 line digest of the Claude Code session that just ended: what was done,
what was deferred, anything that looks stuck. Propose tasks rather than creating
duplicates. Reply NO_REPLY if the session was trivial.
`,

  'self-improvement-digest': `---
trigger: cron 30 21 * * *
context: light
deliver: [auto]
enabled: false
---
Call list_improvements for today. If there are no applied changes and nothing pending review, reply NO_REPLY.
Otherwise give Tony a short digest: each change you made to yourself today (one line, with its link so he can undo it), then how many proposals are waiting in /review.
`
}

/** The cycle-74 seed content of the ORIGINAL four, verbatim — never edit: upgradeSeedJobs matches
 *  stored rows against it. A narrower union than SeedJobSlug on purpose: self-improvement-digest
 *  (cycle 76) has no V1 predecessor and must never be indexable here — see the file header. */
export const SEED_JOBS_V1_SLUGS = ['morning-brief', 'evening-wrap', 'heartbeat', 'session-digest'] as const
export const SEED_JOBS_V1: Record<(typeof SEED_JOBS_V1_SLUGS)[number], string> = {
  'morning-brief': `---
trigger: cron 30 7 * * 1-5
context: light
enabled: false
---
Give Tony a morning brief: what's due today and overdue, what changed overnight,
captures waiting in triage, anything stale for 3+ days. Under 10 lines.
If nothing matters, reply NO_REPLY.
`,

  'evening-wrap': `---
trigger: cron 0 21 * * *
context: light
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
