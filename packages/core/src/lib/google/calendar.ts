// server/lib/google/calendar.ts
// Thin Google Calendar v3 REST wrappers over the shared google() client. Every call carries the
// caller's GoogleDeps so tests drive the transport with fakeFetch. No formatting here — the
// agent tools (server/lib/agent/tools/calendar.ts) decide what the model sees.

import { google, type GoogleDeps } from './client'
import type { Connection } from './connections'

const BASE = 'https://www.googleapis.com/calendar/v3'
const MAX_EVENTS_PER_CALENDAR = 100

export type SendUpdates = 'none' | 'all'

export interface CalendarListEntry {
  id: string
  summary?: string
  primary?: boolean
  selected?: boolean
  accessRole?: string
}

/** `date` for an all-day event (end exclusive, Google's convention); `dateTime` otherwise. */
export interface EventTime {
  date?: string | null
  dateTime?: string | null
  timeZone?: string | null
}

export interface EventAttendee {
  email?: string
  displayName?: string
  responseStatus?: string
  self?: boolean
  organizer?: boolean
  comment?: string
  optional?: boolean
}

export interface CalendarEvent {
  id: string
  etag?: string
  updated?: string
  status?: string
  summary?: string
  description?: string
  location?: string
  start?: EventTime
  end?: EventTime
  hangoutLink?: string
  conferenceData?: { entryPoints?: { entryPointType?: string, uri?: string }[] }
  organizer?: { email?: string, displayName?: string, self?: boolean }
  attendees?: EventAttendee[]
  /** Google withheld the guest list (e.g. too many guests, or Tony can't see them). */
  attendeesOmitted?: boolean
  recurringEventId?: string
  colorId?: string
  transparency?: string
  visibility?: string
  reminders?: unknown
}

export interface BusyInterval { start: string, end: string }

const cal = (calendarId: string) => `${BASE}/calendars/${encodeURIComponent(calendarId)}`

/** The calendars Tony has ticked in Google Calendar's sidebar (`selected !== false`). */
export async function listCalendars(c: Connection, deps: GoogleDeps = {}): Promise<CalendarListEntry[]> {
  const res = await google(c, deps).get<{ items?: CalendarListEntry[] }>(`${BASE}/users/me/calendarList`)
  return (res?.items ?? []).filter(e => e.selected !== false)
}

/** Single instances (recurring events expanded), ordered by start. `truncated` when Google has
 *  more than MAX_EVENTS_PER_CALENDAR in the window (a nextPageToken we don't follow). */
export async function listEvents(
  c: Connection, calendarId: string, opts: { timeMin: string, timeMax: string, q?: string }, deps: GoogleDeps = {}
): Promise<{ items: CalendarEvent[], truncated: boolean }> {
  const res = await google(c, deps).get<{ items?: CalendarEvent[], nextPageToken?: string }>(`${cal(calendarId)}/events`, {
    timeMin: opts.timeMin, timeMax: opts.timeMax, singleEvents: true, orderBy: 'startTime',
    q: opts.q, maxResults: MAX_EVENTS_PER_CALENDAR
  })
  return { items: (res?.items ?? []).filter(e => e.status !== 'cancelled'), truncated: !!res?.nextPageToken }
}

export async function getEvent(c: Connection, calendarId: string, eventId: string, deps: GoogleDeps = {}): Promise<CalendarEvent> {
  return await google(c, deps).get<CalendarEvent>(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`)
}

export async function insertEvent(c: Connection, calendarId: string, body: Record<string, unknown>, sendUpdates: SendUpdates, deps: GoogleDeps = {}): Promise<CalendarEvent> {
  return await google(c, deps).post<CalendarEvent>(`${cal(calendarId)}/events`, body, { sendUpdates })
}

export async function patchEvent(c: Connection, calendarId: string, eventId: string, body: Record<string, unknown>, sendUpdates: SendUpdates, deps: GoogleDeps = {}): Promise<CalendarEvent> {
  return await google(c, deps).patch<CalendarEvent>(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, body, { sendUpdates })
}

export async function deleteEvent(c: Connection, calendarId: string, eventId: string, sendUpdates: SendUpdates, deps: GoogleDeps = {}): Promise<void> {
  await google(c, deps).del(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, { sendUpdates })
}

/** Busy intervals per calendar id; a calendar Google could not read comes back in `errors`. */
export async function freeBusy(
  c: Connection, timeMin: string, timeMax: string, calendarIds: string[], deps: GoogleDeps = {}
): Promise<{ busy: BusyInterval[], errors: string[] }> {
  const res = await google(c, deps).post<{ calendars?: Record<string, { busy?: BusyInterval[], errors?: { reason?: string }[] }> }>(
    `${BASE}/freeBusy`, { timeMin, timeMax, items: calendarIds.map(id => ({ id })) })
  const busy: BusyInterval[] = []
  const errors: string[] = []
  for (const [id, entry] of Object.entries(res?.calendars ?? {})) {
    if (entry.errors?.length) errors.push(`${id}: ${entry.errors.map(e => e.reason ?? 'error').join(', ')}`)
    busy.push(...(entry.busy ?? []))
  }
  return { busy, errors }
}
