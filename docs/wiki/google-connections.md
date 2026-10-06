---
title: Google connections (Gmail, Calendar, Contacts for Bridget)
status: built
cycle: 79
updated: 2026-10-06
mymind_id: abfd2326-dd5f-4138-8318-075b623300be
mymind_hash: ec3c6233d43f541dfc32e5e9f1debbf6bb05f70c489193e72b3e2251150322f5
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
  from `BETTER_AUTH_SECRET`). After a rotation the old tokens no longer decrypt; better-auth hides
  that behind a generic "Failed to get a valid access token", so `token.ts` checks
  `connectionDeps.tokensUndecryptable` on any non-`invalid_grant` token failure and marks the
  connection `needs_reconnect` on its first call after the rotation. Reconnect re-stores the tokens.
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
| `connections.ts` | list/upsert/markReconnect/touch connections; `tokensUndecryptable` (stored tokens fail to decrypt under the current secret) |
| `token.ts` | `googleToken` (in-process `getAccessToken`), `forceRefresh` (in-process `refreshToken`); `GoogleReconnectError` + `needs_reconnect` on `invalid_grant` **or** undecryptable stored tokens |
| `client.ts` | `google(c)` REST client: 401 → forced refresh + one retry (reconnect only on `invalid_grant`); 429/503 → one backoff retry; 403 **missing scope** (`insufficientPermissions` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT`) → `GoogleScopeError` for that one service ("your <label> account didn't grant <service> access — reconnect it …"), the account stays `ok`; any other 403 (API not enabled, policy) → plain `GoogleApiError`; `googleErrorMessage` |
| `accounts.ts` | `resolveAccounts(account, { write })` (writes must name an account), `fanOut` (parallel reads across accounts; a failing account becomes a warning) |
| `mime.ts` | RFC 2822 build (rejects CR/LF in headers, CRLF bodies, RFC 2047 subjects) / parse (text/plain preferred, HTML → text) |
| `gmail.ts`, `calendar.ts`, `people.ts` | thin endpoint wrappers |
| `approval-pins.ts` | nonce-keyed, one-shot, 15-min pins binding an approval card to exactly what gets sent |
| `time.ts`, `untrusted.ts` | agent-tz rendering + strict time parsing; the untrusted-content note |
| `manage.ts` | the Settings API (list / rename / disconnect = revoke at Google — token in the form body, not the URL — + delete the google `account` row) |

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
  `activity_log`. Cards show the **whole** outgoing text (email body, guest-event description, RSVP
  note — no cap; the web card scrolls). iMessage approvals get dedicated "Send this email?" /
  calendar / titled formats with a ceiling, and any cut says "showing N of M chars — open the
  draft/event before approving".
- Web client keeps approval details **per request** (`app/lib/agent/approvals.ts`, keyed by
  requestId = the tool part's `approval.id`): concurrent dangerous calls in one step each keep their
  own card. A non-`exec` card with no details offers **Deny only** ("Details unavailable — deny").
- **Run-level taint (exfiltration guard; cycle 79 I3, hardened 79b).** Two flags on `AgentTool`:
  `taints` — the result carries third-party Google text (`gmail_search`, `gmail_read_thread`,
  `gmail_draft`, `contacts_search`, `calendar_list_events`, `calendar_write_event`,
  `calendar_guest_event`, `calendar_rsvp`; `calendar_find_free_time` does not) — and `outbound`
  (was `egress`) — the call sends model-chosen text where Tony isn't watching: `web_fetch`,
  `web_search`, `research_web`, the job/wake tools `create_job`, `edit_job`, `run_job`,
  `schedule_wake`, and the skill writers `create_skill`, `edit_skill` (jobs follow skills unwatched). `buildAiTools` keeps one flag per run (`server/lib/agent/ai-tools.ts`):
  - **Seeded across turns.** `runAgent` (`run.ts`) starts the run tainted iff the history the model
    will actually see — after `applyHistoryPolicy`, the same policed list the prompt is built from —
    holds a `taints` record whose result is still present and produced content
    (`historyCarriesTaint` in `tool-history.ts`). Records are recognised by the fixed global
    `TAINTING_TOOL_NAMES` (`profile.ts`, every `taints` tool incl. the dangerous calendar ones) —
    never by the run's registry, which in a headless run lacks the dangerous tools. Elided (out of the 3-tool-turn window), `{ error }`,
    `{ denied }`, `{ proposed }` and callId-less legacy records don't count; a capped preview does.
    So the taint persists while mail text is in context and clears after `/clear` (epoch) or once
    it scrolls out of the window.
  - **Flips in-run** the first time a `taints` tool returns content (`producedContent`), and never
    resets within the run.
  - **While tainted, every `outbound` call goes through the approval gate** — never allowlistable,
    body-free `logSummary`, headless (no approval channel) auto-denies. Card title: web reads
    "Web request after reading your mail" (exact URL / query / brief); non-read outbound tools
    "Background work after reading your mail" (the job markdown / wake `when` + `prompt` / skill
    body; `run_job` adds the stored job and `edit_job` the job as it would be saved, via
    `outboundDetail`). Untainted, outbound tools run freely.
  - **exec while tainted** skips its allowlist/LAN `autoApprove` fast path and always asks —
    card "Command after reading your mail", not allowlistable; headless auto-denies.
    `send_message` (Tony-only target) is unaffected.
  - **Consequence:** a main-thread headless job/wake that fires while a mail read is still in the
    window gets every web/exec/job call auto-denied (`{ denied: true }`).
- **Model-written markdown is sanitized** (`app/lib/agent/markdown-harden.ts` →
  `agentMarkdownProps`, bound by `MessageResponse` and `ReasoningContent`; the full-bleed voice
  caption also renders through `MessageResponse`). A comark `post` plugin allowlists the parsed
  tree: only plain-markdown tags survive (raw-HTML/MDC tags like `style`, `link`, `video`,
  `picture`, `svg`, `iframe` are dropped with their content; `div`/`span`/MDC components are
  unwrapped to their text), each tag keeps only the attributes markdown produces (no `style`
  except table `text-align`, no `ping`/`poster`/`srcset`/`on*`), and an image renders only from
  `/api/images/…` (anything else becomes its alt text). Link favicons are off; links stay
  clickable (the library confirms external links). **Not covered:** `MdView`/MDC renders of data
  at rest — documents (incl. `save_document` output), review triage captures, shared docs — still
  load off-origin images/HTML; no app-wide CSP yet (both follow-ups).
- **Per-call headless proposals (79b).** `AgentTool.proposeWhen?(args)`: in `headlessTools`
  (`runtime/gate.ts`) a tool classified `run` whose `proposeWhen(args)` is true is proposed to
  /review for that call (handler not called). `gmail_draft` sets `proposeWhen: a => !!a.draftId` —
  a background run may create drafts but not overwrite an existing one unattended. Approving the
  proposal (`runtime/replay.ts`) runs the real registry handler; interactive runs ignore `proposeWhen`.
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
