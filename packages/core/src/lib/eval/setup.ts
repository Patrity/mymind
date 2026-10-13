// Cycle 85 (spec §3.1): a case's `setup` — the recorded world it runs against. Validated on import
// and when a world is installed, so a malformed fixture fails loudly before any attempt runs.
import { z } from 'zod'

const GmailFixtureMessageSchema = z.object({
  id: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  from: z.string().optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  subject: z.string(),
  /** ISO timestamp; defaults to a fixed date (deterministic ordering). */
  date: z.string().optional(),
  body: z.string(),
  /** Gmail label ids; default INBOX (+ UNREAD unless `unread: false`), or SENT for `sent`. */
  labels: z.array(z.string()).optional(),
  unread: z.boolean().optional()
})

const CalendarFixtureEventSchema = z.object({
  id: z.string().min(1).optional(),
  calendarId: z.string().min(1).optional(),
  summary: z.string(),
  /** ISO date-time, or YYYY-MM-DD for an all-day event (end exclusive, as Google). */
  start: z.string(),
  end: z.string(),
  timeZone: z.string().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  organizer: z.string().optional(),
  attendees: z.array(z.union([z.string(), z.object({ email: z.string(), responseStatus: z.string().optional(), self: z.boolean().optional() })])).optional()
})

const WebPageSchema = z.object({
  status: z.number().int().min(100).max(599).optional(),
  html: z.string().optional(),
  text: z.string().optional()
})

const SearchResultSchema = z.object({ title: z.string(), url: z.string(), snippet: z.string() })

export const EvalSetupSchema = z.object({
  /** Workspace files (path → content) for the attempt's sandbox workspace. */
  files: z.record(z.string(), z.string()).optional(),
  gmail: z.object({
    /** The fixture account's label / address (default `personal` / `tony@eval.example`). */
    account: z.string().min(1).optional(),
    email: z.string().min(3).optional(),
    messages: z.array(GmailFixtureMessageSchema).optional(),
    sent: z.array(GmailFixtureMessageSchema).optional(),
    contacts: z.array(z.object({ name: z.string(), emails: z.array(z.string()), phones: z.array(z.string()).optional() })).optional()
  }).optional(),
  calendar: z.object({ events: z.array(CalendarFixtureEventSchema).optional() }).optional(),
  web: z.object({
    /** Exact URL → page. Any other URL is a 404. */
    pages: z.record(z.string(), WebPageSchema).optional(),
    /** Query pattern (case-insensitive regex; a plain substring if it is not a valid regex) →
     *  results. The first matching pattern answers; no match → no results. */
    search: z.record(z.string(), z.array(SearchResultSchema)).optional()
  }).optional(),
  /** Seeded into the world's tenant before the attempt. */
  memories: z.array(z.object({ content: z.string().min(1), scope: z.enum(['user', 'agent', 'world']).optional(), project: z.string().optional(), tags: z.array(z.string()).optional() })).optional(),
  tasks: z.array(z.object({ title: z.string().min(1), description: z.string().optional(), status: z.string().optional(), project: z.string().optional() })).optional(),
  /** The scripted approver (spec §3.2): which approval cards are approved. Default `none`. */
  approve: z.union([z.literal('all'), z.literal('none'), z.array(z.string())]).optional()
})

export type EvalSetup = z.infer<typeof EvalSetupSchema>
export type GmailFixtureMessage = z.infer<typeof GmailFixtureMessageSchema>
export type CalendarFixtureEvent = z.infer<typeof CalendarFixtureEventSchema>

export function parseEvalSetup(raw: unknown): EvalSetup {
  return EvalSetupSchema.parse(raw ?? {})
}
