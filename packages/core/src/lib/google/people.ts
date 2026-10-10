// server/lib/google/people.ts
// People API contact search over BOTH saved contacts and "other contacts" (addresses Tony has
// emailed but never saved). Google's search indexes are lazily built: the docs require one
// request with an empty query to warm the cache before searches return fresh results. We issue
// that at most once per process per connection, and a failed warm-up never fails the search.

import { google, type GoogleDeps } from './client'
import type { Connection } from './connections'

const BASE = 'https://people.googleapis.com/v1'
const READ_MASK = 'names,emailAddresses,phoneNumbers'
const PAGE_SIZE = 10

export interface PersonHit {
  name: string
  emails: string[]
  phones: string[]
  source: 'saved' | 'other'
}

interface PeopleSearchResponse {
  results?: {
    person?: {
      names?: { displayName?: string }[]
      emailAddresses?: { value?: string }[]
      phoneNumbers?: { value?: string }[]
    }
  }[]
}

const warmed = new Set<string>()

/** Test-only: forget which connections have been warmed. */
export function resetPeopleWarmup(): void {
  warmed.clear()
}

const ENDPOINT = { saved: `${BASE}/people:searchContacts`, other: `${BASE}/otherContacts:search` } as const

async function warmUp(c: Connection, deps: GoogleDeps): Promise<void> {
  if (warmed.has(c.id)) return
  warmed.add(c.id)
  const g = google(c, deps)
  await Promise.allSettled((['saved', 'other'] as const).map(src =>
    g.get(ENDPOINT[src], { query: '', readMask: READ_MASK, pageSize: PAGE_SIZE })))
}

function toHits(res: PeopleSearchResponse, source: PersonHit['source']): PersonHit[] {
  return (res.results ?? []).flatMap((r) => {
    const p = r.person
    if (!p) return []
    const emails = (p.emailAddresses ?? []).map(e => e.value).filter((v): v is string => !!v)
    const phones = (p.phoneNumbers ?? []).map(e => e.value).filter((v): v is string => !!v)
    const name = p.names?.find(n => n.displayName)?.displayName ?? emails[0] ?? ''
    return [{ name, emails, phones, source }]
  })
}

const SOURCE_NAME = { saved: 'saved contacts', other: 'other contacts' } as const

/** Saved contacts first, then other contacts. One source failing (e.g. an older connection
 *  without the contacts.other.readonly scope) keeps the other's hits and reports the failure via
 *  `onWarning`; only BOTH failing throws (fanOut turns that into a per-account warning). */
export async function searchPeople(
  c: Connection, q: string, deps: GoogleDeps = {}, onWarning?: (source: string, err: unknown) => void
): Promise<PersonHit[]> {
  await warmUp(c, deps)
  const g = google(c, deps)
  const sources = ['saved', 'other'] as const
  const settled = await Promise.allSettled(sources.map(src =>
    g.get<PeopleSearchResponse>(ENDPOINT[src], { query: q, readMask: READ_MASK, pageSize: PAGE_SIZE })))
  if (settled.every(s => s.status === 'rejected')) throw (settled[0] as PromiseRejectedResult).reason
  return settled.flatMap((s, i) => {
    const src = sources[i]!
    if (s.status === 'fulfilled') return toHits(s.value, src)
    onWarning?.(SOURCE_NAME[src], s.reason)
    return []
  })
}
