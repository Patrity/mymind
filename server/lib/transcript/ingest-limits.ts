import { z } from 'zod'

/**
 * Wire limits for the cc-hook transcript inlet.
 *
 * History: this schema used to cap every line at 100_000 chars. Claude Code
 * JSONL lines routinely exceed that — one big tool result or file read is
 * enough (observed up to 2.08 MB) — and Zod rejects the WHOLE batch on a single
 * bad element. Because cc-hook only advances its byte offset on a 2xx, that
 * turned one oversized line into a permanent head-of-line block: the session
 * re-POSTed the same doomed payload on every terminal event, forever. ~0.4% of
 * lines wedged 324 sessions and 1.54 GB of transcript, and prod message ingest
 * stopped dead on 2026-09-07.
 *
 * The fix is to accept the line intact (the parser needs valid JSON — truncating
 * the raw line just makes JSON.parse fail and the message vanish silently) and
 * clamp the PARSED fields instead. See MAX_FIELD_CHARS in transcript-parse.ts.
 *
 * What remains is a whole-body guard, so a runaway payload fails loudly and
 * cheaply instead of being parsed into memory.
 */

/** Cap on total characters across all lines in one request (~48 MB of UTF-16). */
export const MAX_BODY_CHARS = 24_000_000

/**
 * Cap on line COUNT. cc-hook ships a 4 MB window per request; at ~200 bytes a
 * line that is ~20k lines, so the old 5000 was reachable on chatty sessions.
 */
export const MAX_LINES = 50_000

export const TranscriptBody = z.object({
  source: z.string().default('claude_code'),
  external_id: z.string(),
  lines: z.array(z.string()).max(MAX_LINES)
}).refine(
  b => b.lines.reduce((n, l) => n + l.length, 0) <= MAX_BODY_CHARS,
  { message: `transcript batch exceeds ${MAX_BODY_CHARS} characters`, path: ['lines'] }
)

export type TranscriptBodyInput = z.infer<typeof TranscriptBody>
