// server/lib/exec/approvals.ts
// Pure helpers for the exec approval allowlist + the exec_approvals DB store.
// The pure section is unit-tested; the store section mirrors search/store.ts.

import { isCatastrophic, classifyOutbound, extractExternalHosts } from './outbound'

// Shell metacharacters that chain/compose commands. A wildcard must NOT span
// these, so an approved prefix can never be turned into a second command.
const META = ';&|`$()<>\n\r'
const METACLASS = '[^' + META.replace(/[\\\]^-]/g, '\\$&') + ']*'

// Outbound tools that can exfiltrate data externally. A bare `<tool> *` pattern
// for these must never be saved — it would silently approve ALL outbound traffic.
const OUTBOUND_TOOL_HEADS = new Set(['curl', 'wget'])

export function validatePattern(pattern: string): { valid: boolean; error?: string } {
  const p = pattern.trim()
  if (!p) return { valid: false, error: 'pattern is empty' }
  // host:<hostname> is the ONLY form accepted for outbound allowlisting.
  if (p.startsWith('host:')) {
    const hostname = p.slice(5)
    if (!hostname) return { valid: false, error: 'host: pattern must include a hostname' }
    if (!/^[a-zA-Z0-9.\-]+$/.test(hostname)) return { valid: false, error: 'host: pattern hostname must contain only letters, digits, dots, and hyphens' }
    return { valid: true }
  }
  // Strip wildcards + whitespace; a pattern must carry at least one literal char.
  if (!p.replace(/\*/g, '').trim()) return { valid: false, error: 'pattern must contain a literal command, not just "*"' }
  // The command head (first whitespace-delimited token) must be a literal — no wildcard.
  // A leading wildcard (*foo, * status) matches arbitrary commands and is therefore rejected.
  const tokens = p.split(/\s+/)
  const head = tokens[0]
  if (head && head.includes('*')) return { valid: false, error: 'command head must be a literal (no wildcard in the first token)' }
  // Any command-glob headed by an outbound tool is rejected — the ONLY way to allowlist
  // outbound traffic is via a `host:<hostname>` pattern. Glob-headed outbound patterns
  // are exploitable via substring embedding (attacker.io/https://approved.host/).
  if (head && OUTBOUND_TOOL_HEADS.has(head)) {
    return { valid: false, error: `command glob with outbound head '${head}' is not allowed — use 'host:<hostname>' to allowlist outbound traffic` }
  }
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
  if (!first) return ''
  // For external outbound commands, propose a host:<hostname> pattern.
  // This is the ONLY safe form: it matches on exact host membership, not substrings.
  if (classifyOutbound(command) === 'external') {
    const hosts = extractExternalHosts(command)
    if (hosts[0]) return `host:${hosts[0]}`
  }
  return `${first} *`
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

// ---- exec_approvals DB store (mirrors search/store.ts: thin Drizzle I/O) ----
import { and, eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { execApprovals, type ExecApproval } from '../../db/schema'

export type { ExecApproval }

export async function loadApprovals(tool?: string): Promise<ExecApproval[]> {
  const db = useDb()
  const rows = tool
    ? await db.select().from(execApprovals).where(eq(execApprovals.tool, tool))
    : await db.select().from(execApprovals)
  return rows
}

export async function addApproval(input: { pattern: string; tool?: string }): Promise<ExecApproval> {
  const pattern = input.pattern.trim()
  const v = validatePattern(pattern)
  if (!v.valid) throw new Error(v.error ?? 'invalid pattern')
  const tool = input.tool ?? 'exec'
  const db = useDb()
  await db.insert(execApprovals).values({ pattern, tool }).onConflictDoNothing()
  const [row] = await db.select().from(execApprovals)
    .where(and(eq(execApprovals.tool, tool), eq(execApprovals.pattern, pattern))).limit(1)
  return row!
}

export async function updateApproval(id: string, pattern: string): Promise<ExecApproval | null> {
  const next = pattern.trim()
  const v = validatePattern(next)
  if (!v.valid) throw new Error(v.error ?? 'invalid pattern')
  const db = useDb()
  const [row] = await db.update(execApprovals).set({ pattern: next })
    .where(eq(execApprovals.id, id)).returning()
  return row ?? null
}

export async function deleteApproval(id: string): Promise<void> {
  await useDb().delete(execApprovals).where(eq(execApprovals.id, id))
}

export async function touchApproval(id: string): Promise<void> {
  await useDb().update(execApprovals).set({ lastUsedAt: new Date() }).where(eq(execApprovals.id, id))
}

// ---- Pure auto-approve decision (no I/O) ----

/** Allowlist-first decision for exec. allow=true ⇒ run silently; allow=false ⇒ prompt the human. */
export function execAutoApproveDecision(input: { command: string; patterns: string[] }): { allow: boolean; reason: string } {
  const { command, patterns } = input
  if (isCatastrophic(command)) return { allow: false, reason: 'catastrophic' } // prompt; handler hard-blocks anyway
  const outbound = classifyOutbound(command)
  if (outbound === 'lan') return { allow: true, reason: 'lan' }               // LAN always allowed
  if (outbound === 'external') {
    // SECURITY: outbound commands NEVER go through glob matching.
    // Only exact host-set membership is checked to prevent substring-embedding exfil.
    const hosts = extractExternalHosts(command)
    const approvedHosts = new Set(
      patterns.filter(p => p.startsWith('host:')).map(p => p.slice(5).toLowerCase())
    )
    if (hosts.length > 0 && hosts.every(h => approvedHosts.has(h))) {
      return { allow: true, reason: 'host-allowlisted' }
    }
    return { allow: false, reason: 'external-unlisted' }
  }
  // Command is an outbound tool (curl/wget) but no parseable URL was found (e.g. `curl $URL`).
  // Never auto-approve — shell variable expansion could reach any host.
  const OUTBOUND_TOOLS_RE = /\b(curl|wget)\b/
  if (OUTBOUND_TOOLS_RE.test(command)) {
    return { allow: false, reason: 'outbound-unparsed' }
  }
  // Non-outbound command: standard glob matching.
  return matchesApproval(command, patterns)
    ? { allow: true, reason: 'allowlisted' }
    : { allow: false, reason: 'unlisted' }
}
