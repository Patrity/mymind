// Cycle 85 (spec §3.1): a case's `setup` — the recorded world it runs against. Validated on import
// and when a world is installed, so a malformed fixture fails loudly before any attempt runs.
import { z } from 'zod'

/** Task 4 fix round 1: import caps (a suite arrives over HTTP now). A fixture body (an email, a page,
 *  a file, a document) ≤ 200k chars; every other fixture string ≤ 2k; every fixture list ≤ 500. The
 *  route also caps the whole request at 2 MB. */
export const FIXTURE_BODY_MAX = 200_000
export const FIXTURE_STRING_MAX = 2_000
export const FIXTURE_LIST_MAX = 500
const str = () => z.string().max(FIXTURE_STRING_MAX)
const body = () => z.string().max(FIXTURE_BODY_MAX)
const list = <T extends z.ZodTypeAny>(t: T) => z.array(t).max(FIXTURE_LIST_MAX)
const rec = <T extends z.ZodTypeAny>(t: T) => z.record(str(), t).refine(r => Object.keys(r).length <= FIXTURE_LIST_MAX, { message: `at most ${FIXTURE_LIST_MAX} entries` })

const GmailFixtureMessageSchema = z.object({
  id: str().min(1).optional(),
  threadId: str().min(1).optional(),
  from: str().optional(),
  to: list(str()).optional(),
  cc: list(str()).optional(),
  subject: str(),
  /** ISO timestamp; defaults to a fixed date (deterministic ordering). */
  date: str().optional(),
  body: body(),
  /** Gmail label ids; default INBOX (+ UNREAD unless `unread: false`), or SENT for `sent`. */
  labels: list(str()).optional(),
  unread: z.boolean().optional()
})

const CalendarFixtureEventSchema = z.object({
  id: str().min(1).optional(),
  calendarId: str().min(1).optional(),
  summary: str(),
  /** ISO date-time, or YYYY-MM-DD for an all-day event (end exclusive, as Google). */
  start: str(),
  end: str(),
  timeZone: str().optional(),
  location: str().optional(),
  description: body().optional(),
  organizer: str().optional(),
  attendees: list(z.union([str(), z.object({ email: str(), responseStatus: str().optional(), self: z.boolean().optional() })])).optional()
})

const WebPageSchema = z.object({
  status: z.number().int().min(100).max(599).optional(),
  html: body().optional(),
  text: body().optional()
})

const SearchResultSchema = z.object({ title: str(), url: str(), snippet: str() })

export const EvalSetupSchema = z.object({
  /** Workspace files (path → content) for the attempt's sandbox workspace. */
  files: rec(body()).optional(),
  gmail: z.object({
    /** The fixture account's label / address (default `personal` / `tony@eval.example`). */
    account: str().min(1).optional(),
    email: str().min(3).optional(),
    messages: list(GmailFixtureMessageSchema).optional(),
    sent: list(GmailFixtureMessageSchema).optional(),
    contacts: list(z.object({ name: str(), emails: list(str()), phones: list(str()).optional() })).optional()
  }).optional(),
  calendar: z.object({ events: list(CalendarFixtureEventSchema).optional() }).optional(),
  web: z.object({
    /** Exact URL → page. Any other URL is a 404. */
    pages: rec(WebPageSchema).optional(),
    /** Query pattern (case-insensitive regex; a plain substring if it is not a valid regex) →
     *  results. The first matching pattern answers; no match → no results. */
    search: rec(list(SearchResultSchema)).optional()
  }).optional(),
  /** Seeded into the world's tenant before the attempt. */
  memories: list(z.object({ content: body().min(1), scope: z.enum(['user', 'agent', 'world']).optional(), project: str().optional(), tags: list(str()).optional() })).optional(),
  tasks: list(z.object({ title: str().min(1), description: body().optional(), status: str().optional(), project: str().optional() })).optional(),
  /** Task 3: documents seeded into the world's tenant (path → a markdown doc). */
  documents: list(z.object({ path: str().regex(/^\/[^\0]+$/, 'an absolute document path'), title: str().optional(), content: body() })).optional(),
  /** Task 3: channels configured in the world (they are "not set up" otherwise — the settings
   *  allow-list never copies Tony's). Seeded into the world's tenant only for a case that sets it;
   *  every send is captured by the outbox, never delivered. */
  channels: z.object({
    imessage: z.object({ handle: str().min(3) }).optional(),
    email: z.object({ to: str().min(3) }).optional()
  }).optional(),
  /** The scripted approver (spec §3.2): which approval cards are approved. Default `none`. */
  approve: z.union([z.literal('all'), z.literal('none'), list(str())]).optional()
})

export type EvalSetup = z.infer<typeof EvalSetupSchema>
export type GmailFixtureMessage = z.infer<typeof GmailFixtureMessageSchema>
export type CalendarFixtureEvent = z.infer<typeof CalendarFixtureEventSchema>

export function parseEvalSetup(raw: unknown): EvalSetup {
  return EvalSetupSchema.parse(raw ?? {})
}
