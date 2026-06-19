// server/lib/exec/approvals.ts
// Pure helpers for the exec approval allowlist + the exec_approvals DB store.
// The pure section is unit-tested; the store section mirrors search/store.ts.

// Shell metacharacters that chain/compose commands. A wildcard must NOT span
// these, so an approved prefix can never be turned into a second command.
const META = ';&|`$()<>\n\r'
const METACLASS = '[^' + META.replace(/[\\\]^-]/g, '\\$&') + ']*'

export function validatePattern(pattern: string): { valid: boolean; error?: string } {
  const p = pattern.trim()
  if (!p) return { valid: false, error: 'pattern is empty' }
  // Strip wildcards + whitespace; a pattern must carry at least one literal char.
  if (!p.replace(/\*/g, '').trim()) return { valid: false, error: 'pattern must contain a literal command, not just "*"' }
  return { valid: true }
}

/** Compile a glob (`*` = any run of non-chaining chars) to an anchored RegExp. */
function compile(pattern: string): RegExp | null {
  if (!validatePattern(pattern).valid) return null
  const body = pattern.trim()
    .split('*')
    .map(seg => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join(METACLASS)
  return new RegExp('^' + body + '$')
}

export function matchesApproval(command: string, patterns: string[]): boolean {
  const cmd = command.trim()
  if (!cmd) return false
  for (const p of patterns) {
    const re = compile(p)
    if (re && re.test(cmd)) return true
  }
  return false
}

export function proposedPattern(command: string): string {
  const first = command.trim().split(/\s+/)[0]
  return first ? `${first} *` : ''
}

export type ApprovalDecisionEvent =
  | { kind: 'approve'; remember?: boolean; pattern?: string; proposedPattern: string }
  | { kind: 'deny' }
  | { kind: 'timeout' }

export function approvalOutcome(ev: ApprovalDecisionEvent): { approved: boolean; persist: boolean; pattern: string | null } {
  if (ev.kind !== 'approve') return { approved: false, persist: false, pattern: null }
  if (!ev.remember) return { approved: true, persist: false, pattern: null }
  const pattern = (ev.pattern?.trim() || ev.proposedPattern).trim()
  return { approved: true, persist: true, pattern }
}
