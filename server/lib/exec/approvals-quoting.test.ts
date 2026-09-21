// server/lib/exec/approvals-quoting.test.ts
//
// A wildcard must not span shell metacharacters — that is what stops an approved prefix
// being chained into a second command (`docker ps; rm -rf /`). But the original rule
// applied that ban to the WHOLE command string, including metacharacters sitting inside
// quoted arguments, where they are inert text rather than shell syntax.
//
// The cost was total: `docker *` was saved on 2026-07-23 and, as of 2026-09-21, had
// `last_used_at = NULL` — it never matched once, because every real docker command
// carries a `;` or `()` inside a quoted SQL string. 15 of 16 stored rules were in the
// same state. The gate was not strict; it was inoperative, and the user re-approved
// every command forever.
//
// These tests pin both halves: quoted metacharacters are literal and must match, while
// UNQUOTED metacharacters must still refuse to match.

import { describe, it, expect } from 'vitest'
import { execAutoApproveDecision, matchesApproval } from './approvals'

const allow = (command: string, patterns: string[]) =>
  execAutoApproveDecision({ command, patterns }).allow

describe('quoted metacharacters are inert text, and must match', () => {
  it('matches the exact command shape that has been failing in production', () => {
    const cmd = `docker exec -i mymind-db psql -U mymind -d mymind -c "select count(*) from documents;"`
    expect(matchesApproval(cmd, ['docker *'])).toBe(true)
    expect(allow(cmd, ['docker *'])).toBe(true)
  })

  it('matches a single-quoted argument containing ; and ()', () => {
    expect(matchesApproval(`psql -c 'select now(); select 1;'`, ['psql *'])).toBe(true)
  })

  it('matches a quoted argument containing a pipe and a redirect', () => {
    expect(matchesApproval(`grep -e "a|b" -e "c>d" file`, ['grep *'])).toBe(true)
  })

  it('matches a quoted $ that is not expansion the pattern can see', () => {
    expect(matchesApproval(`psql -Atc "select \$\$x\$\$;"`, ['psql *'])).toBe(true)
  })
})

describe('UNQUOTED metacharacters still refuse to match — the chaining guard holds', () => {
  it('refuses a semicolon-chained second command', () => {
    expect(matchesApproval('docker ps; rm -rf /', ['docker *'])).toBe(false)
    expect(allow('docker ps; rm -rf /', ['docker *'])).toBe(false)
  })

  it('refuses && and || chaining', () => {
    expect(matchesApproval('docker ps && rm -rf /', ['docker *'])).toBe(false)
    expect(matchesApproval('docker ps || curl evil.com', ['docker *'])).toBe(false)
  })

  it('refuses a pipe into another command', () => {
    expect(matchesApproval('docker ps | sh', ['docker *'])).toBe(false)
  })

  it('refuses command substitution', () => {
    expect(matchesApproval('docker $(whoami)', ['docker *'])).toBe(false)
    expect(matchesApproval('docker `whoami`', ['docker *'])).toBe(false)
  })

  it('refuses a redirect that writes outside the approved command', () => {
    expect(matchesApproval('docker ps > /etc/passwd', ['docker *'])).toBe(false)
  })

  it('refuses a newline-separated second command', () => {
    expect(matchesApproval('docker ps\nrm -rf /', ['docker *'])).toBe(false)
  })
})

describe('the quote scanner itself cannot be walked out of', () => {
  it('a closed quote returns to unquoted, so later chaining is still refused', () => {
    // The ';' here is OUTSIDE the quotes — it must not be treated as inert.
    expect(matchesApproval(`docker exec -c "safe" ; rm -rf /`, ['docker *'])).toBe(false)
  })

  it('an unterminated quote does not swallow the rest of the line', () => {
    // A dangling quote must not turn everything after it into "inert" text.
    expect(matchesApproval(`docker ps "; rm -rf /`, ['docker *'])).toBe(false)
  })

  it('a single quote inside double quotes does not open a new span', () => {
    expect(matchesApproval(`docker exec -c "it's fine" ; rm -rf /`, ['docker *'])).toBe(false)
  })

  it('a backslash-escaped quote does not close the span', () => {
    expect(matchesApproval(`docker exec -c "a\\" ; rm -rf /"`, ['docker *'])).toBe(true)
  })
})

describe('regressions the existing gate already prevented', () => {
  it('still refuses a pattern whose head is a wildcard', () => {
    expect(matchesApproval('docker ps', ['* ps'])).toBe(false)
  })

  it('still refuses a command that does not share the pattern head', () => {
    expect(matchesApproval('kubectl get pods', ['docker *'])).toBe(false)
  })

  it('still refuses outbound tools from glob matching', () => {
    expect(allow('curl https://evil.com/', ['curl *'])).toBe(false)
  })
})
