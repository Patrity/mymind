---
title: Google connections (Gmail, Calendar, Contacts for Bridget)
status: built
cycle: 79
updated: 2026-10-06
---

# Google connections

Bridget can search, read, draft, send and triage Gmail, read and manage Google Calendar, and look up
contacts across several linked Google accounts (Tony: work Workspace + personal Gmail). Everything is
inert until the server has Google OAuth credentials **and** an account is linked.

Spec: [`2026-10-05-google-connections-design.md`](../superpowers/specs/2026-10-05-google-connections-design.md).
Setup: [`DEPLOYMENT.md` §20](../DEPLOYMENT.md).

## Linking (OAuth)

- better-auth `socialProviders.google` (only when `NUXT_GOOGLE_CLIENT_ID` / `NUXT_GOOGLE_CLIENT_SECRET`
  are set), used **only via `linkSocial`** from Settings → Connections. Options live in
  `server/lib/google/auth-options.ts`: `accessType: 'offline'`, `prompt: 'consent'`, the scope list
  from `shared/utils/google-scopes.ts`, `disableSignUp`, `disableIdTokenSignIn`, `disableImplicitLinking`,
  `disableDefaultScope`, plus a `refreshAccessToken` override that detects `invalid_grant`.
- **No Google sign-in:** a `hooks.before` rejects `/sign-in/social` (403) — a linked Google account can
  never log anyone in. `disabledPaths` removes `/get-access-token`, `/refresh-token`, `/account-info`
  from HTTP (server code still calls `auth.api.*` in-process).
- Tokens live in better-auth's `account` table, encrypted (`account.encryptOAuthTokens`, key derived
  from `BETTER_AUTH_SECRET` — rotating it makes every connection `needs_reconnect`).
- Scopes: `openid email profile`, `gmail.modify`, `calendar.events`, `calendar.readonly`,
  `contacts.readonly`, `contacts.other.readonly`.

## Data — `connections` (migration 0067)

`id`, `account_id` (unique → `account.id`, cascade), `provider` (`google`), `label` (unique per
provider; default from the email domain, editable), `email`, `status` (`ok` / `needs_reconnect`),
`last_error`, `last_used_at`, timestamps. Written by better-auth `databaseHooks.account.create/update.after`
(a re-link updates the account row → status back to `ok`).

## Server modules (`server/lib/google/`)

| module | job |
|---|---|
| `connections.ts` | list/upsert/markReconnect/touch connections |
| `token.ts` | `googleToken` (in-process `getAccessToken`), `forceRefresh` (in-process `refreshToken`), `GoogleReconnectError` on `invalid_grant` |
| `client.ts` | `google(c)` REST client: 401 → forced refresh + one retry (reconnect only on `invalid_grant`); 429/5xx → one backoff retry; 403 insufficient scope → reconnect; `googleErrorMessage` |
| `accounts.ts` | `resolveAccounts(account, { write })` (writes must name an account), `fanOut` (parallel reads across accounts; a failing account becomes a warning) |
| `mime.ts` | RFC 2822 build (rejects CR/LF in headers, CRLF bodies, RFC 2047 subjects) / parse (text/plain preferred, HTML → text) |
| `gmail.ts`, `calendar.ts`, `people.ts` | thin endpoint wrappers |
| `approval-pins.ts` | nonce-keyed, one-shot, 15-min pins binding an approval card to exactly what gets sent |
| `time.ts`, `untrusted.ts` | agent-tz rendering + strict time parsing; the untrusted-content note |
| `manage.ts` | the Settings API (list / rename / disconnect = revoke at Google + delete the google `account` row) |

## Tools (on-demand toolsets)

| toolset | tool | safety | headless |
|---|---|---|---|
| `gmail` | `gmail_search`, `gmail_read_thread`, `contacts_search` | read; results carry an untrusted-content note | run |
| | `gmail_draft` | create; undo deletes/restores; result includes the body | run |
| | `gmail_modify` (archive/read/star/labels) | create; undo restores each message's prior labels | propose |
| | `gmail_send` (only an existing draft) | **dangerous**, approved every call; card shows the draft as Google has it; the send refuses if the draft changed after approval | excluded |
| `calendar` | `calendar_list_events`, `calendar_find_free_time` | read | run |
| | `calendar_write_event` (no guests) | create; refuses events with guests, hidden guest lists, or another organizer; undo re-checks | propose |
| | `calendar_guest_event`, `calendar_rsvp` | **dangerous**, approved every call; bound to the event's etag at card time | excluded |

- Dangerous Google tools live in `bridgetProfile` (not `agentTools`); `/api/mcp` exposes **no** Google tool.
- Approval: `describeApproval(args, { approvalNonce })` — `ai-tools.ts` mints a fresh nonce per
  execution (provider tool-call ids are never trusted for this). Cards carry `title` and a body-free
  `logSummary`; recorders log `logSummary`, so draft bodies / event descriptions never reach
  `activity_log`. iMessage approvals get dedicated "Send this email?" / calendar formats.
- The `gmail` / `calendar` lines are omitted from Bridget's TOOLSETS directory while no connection is `ok`.
- Times: shown in `agent_timezone`; inputs must be ISO with offset, naive ISO (agent-tz local) or a bare date.

## Settings → Connections

`/settings/connections` (`ConnectionsTab.vue`): not-configured alert; per-account card (email, editable
label, scope badges, status, Reconnect, Disconnect via modal); "Connect Google account" → `linkSocial`.
Nav chip turns amber when any connection needs reconnecting. API: `GET /api/connections`,
`PATCH /api/connections/:id`, `DELETE /api/connections/:id` — web session only.

## Known limits

Attachments, HTML compose, forwarding, recurring-series edits, Drive, and background sends/invites are
out of scope (cycle 80 decides background behaviour). Per-calendar event lists cap at 100 (flagged
`truncated`). Approval pins are in-process (a restart between approval and send fails closed).
