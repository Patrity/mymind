// server/lib/agent/runtime/suppress.ts
// The silent-by-default contract for background runs (OpenClaw's NO_REPLY). A wake reply that
// is the sentinel — alone, or opening/closing a short remainder — is dropped: no assistant row.
// A long reply that merely mentions the word is a real reply.
export const NO_REPLY = 'NO_REPLY'
const MAX_RESIDUE = 300

export function isSuppressedReply(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (t === NO_REPLY) return true
  if (!t.startsWith(NO_REPLY) && !t.endsWith(NO_REPLY)) return false
  const residue = t.startsWith(NO_REPLY) ? t.slice(NO_REPLY.length) : t.slice(0, -NO_REPLY.length)
  return residue.trim().length <= MAX_RESIDUE
}
