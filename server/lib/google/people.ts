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

/** Saved contacts first, then other contacts. Either endpoint failing fails the call (fanOut
 *  turns that into a per-account warning). */
export async function searchPeople(c: Connection, q: string, deps: GoogleDeps = {}): Promise<PersonHit[]> {
  await warmUp(c, deps)
  const g = google(c, deps)
  const [saved, other] = await Promise.all((['saved', 'other'] as const).map(src =>
    g.get<PeopleSearchResponse>(ENDPOINT[src], { query: q, readMask: READ_MASK, pageSize: PAGE_SIZE })))
  return [...toHits(saved!, 'saved'), ...toHits(other!, 'other')]
}
