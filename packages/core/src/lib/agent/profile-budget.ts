// server/lib/agent/profile-budget.ts
// Cycle 76, Task 2: the token budget for the "About Tony" profile injected into the system
// prompt (spec: profile <= 1,500 tokens, estimate = ceil(chars / 4)). Pure — no DB, no imports
// from server/services/profile.ts — so buildSystemPrompt's try/catch around the profile LOAD
// (server/lib/agent/prompt.ts) is the only place a failure can originate; clamping itself never
// throws.

export const PROFILE_TOKEN_BUDGET = 1500

/** Same cheap estimate used elsewhere in this codebase: chars/4, rounded up. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

const TRUNCATION_MARKER = '\n…(profile truncated)'

/**
 * Clamps `s` to at most PROFILE_TOKEN_BUDGET tokens (~chars/4). Cuts at the last newline before
 * the char limit so a line is never split mid-word, then appends a truncation marker so the
 * model (and the /settings/profile token meter) knows the tail was dropped. A profile within
 * budget is returned unchanged.
 */
export function clampProfile(s: string): { text: string; truncated: boolean } {
  const limit = PROFILE_TOKEN_BUDGET * 4
  if (s.length <= limit) return { text: s, truncated: false }
  const cut = s.slice(0, limit)
  const lastNewline = cut.lastIndexOf('\n')
  const trimmed = lastNewline > -1 ? cut.slice(0, lastNewline) : cut
  return { text: trimmed + TRUNCATION_MARKER, truncated: true }
}
