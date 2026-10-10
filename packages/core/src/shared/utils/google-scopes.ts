/** Cycle 79: the exact OAuth scopes requested when linking a Google account. Shared so the
 *  Settings → Connections page can compare an account's granted scopes against this list. */
export const GOOGLE_SCOPES: string[] = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly'
]
