---
title: Google connections — Gmail, Calendar and Contacts for Bridget across work + personal accounts (cycle 79)
cycle: 79
date: 2026-10-06
status: deployed  # CD 37430349947 (07d0c4b), 2026-10-06; inert until Google env set; acceptance owed
branch: feat/google-connections (worktree .claude/worktrees/feat+google-connections, base 4eff8bf)
merged: true
deployed: true
specs:
  - ../superpowers/specs/2026-10-05-google-connections-design.md
plans:
  - ../superpowers/plans/2026-10-05-google-connections.md
wiki:
  - ../wiki/google-connections.md
  - ../wiki/agent.md
migrations:
  - 0067 connections (additive; FK account.id on delete cascade)
migrations_run_on_prod: true  # 0067 verified (to_regclass)
google_configured_on_prod: false
acceptance: owed  # spec §7 live list, after Tony's GCP/Workspace setup + env
blocking_before_connect: none  # 79b taint hardening landed (branch fix/taint-hardening) — see "79b" section
next: merge + deploy 79b → Tony's Google setup → live acceptance → cycle 80 (proactive)
---

# Google connections (cycle 79)

Cycle 2 of the connectors programme. Bridget gets two on-demand toolsets — `gmail` (search, read
thread, draft, send-from-draft, triage, contacts) and `calendar` (list, free time, solo writes,
guest events, RSVP) — across several linked Google accounts. Shipped **inert**: nothing appears
until the server has `NUXT_GOOGLE_CLIENT_ID/SECRET` and an account is linked in Settings → Connections.
Current-state reference: [wiki/google-connections.md](../wiki/google-connections.md).

## What shipped
- better-auth Google provider used only via `linkSocial`; **no Google sign-in** (`/sign-in/social` → 403, implicit sign-up / id-token sign-in disabled); HTTP `/get-access-token`, `/refresh-token`, `/account-info` disabled; tokens encrypted.
- `connections` table (0067), account create/update hooks, Settings → Connections page + `GET/PATCH/DELETE /api/connections` (session-only; disconnect revokes at Google).
- `server/lib/google/*`: REST client (401 → forced refresh + retry; reconnect only on `invalid_grant` or undecryptable tokens; per-service scope errors), multi-account fan-out with warnings, strict MIME (header-injection refused), strict agent-tz time parsing.
- 11 tools; outward-facing ones (`gmail_send`, `calendar_guest_event`, `calendar_rsvp`) are dangerous, live on `bridgetProfile`, approved every call. Approval is bound to exactly what is sent by a **per-execution nonce** minted in `ai-tools.ts` (one-shot pins; provider tool-call ids are never trusted); cards show the full outgoing content; `logSummary` keeps bodies out of `activity_log`.
- Web approvals are kept per request; a non-exec card with no details offers Deny only.
- **Run-level taint:** after a Google read returns content, `web_fetch`/`web_search`/`research_web` need approval for the rest of the run; headless auto-denies.
- Google toolsets hidden from Bridget's directory until a connection is `ok`; no Google tool on `/api/mcp`.

## Deviations from the spec
1. Untrusted-content rule lives in the Google tools' descriptions/results, not the always-on prompt (5.6k-char prompt budget).
2. `describeApproval` became async and receives `{ approvalNonce }`; ToolContext carries `approvalNonce`.
3. Reconnect = account **update** → hook on update as well as create.
4. Directory hiding via runner-computed `unavailable`.
5. Dangerous Google tools on `bridgetProfile`, not `agentTools` (keeps the "no dangerous tools in agentTools" invariant).
6. Added (not in spec): run-level egress taint; HTTP token endpoints disabled; explicit sign-in hook.
7. Secret rotation → connections flip to `needs_reconnect` on first use (spec had this as intent; code now detects undecryptable tokens explicitly).

## Evidence
- Gates on 43bc607: typecheck 0; `pnpm test` 3350 passed / 1 skipped; `pnpm test:db` 882 passed; `pnpm build` ok.
- SDD: 6 tasks; fix rounds — T1 1 (Critical: linked Google account could sign in), T2 1 (401 heuristic, header injection), T3 1 (undo prior-state, reply threading), T4 3 (approval-to-content binding: per-draft pin → per-callId → per-execution nonce), T5 1 (organizer/hidden-guest leaks, UTC time parsing), T6 0; final review → 1 fix wave (per-request approvals, full card content, egress taint, docs).
- Mutation checks across every task (each listed in the SDD reports); browser checks of the Connections page (7 states) and concurrent approval cards.
- Pre-merge smoke (dev, no Google env): password login 200; `/sign-in/social` 403; `/get-access-token` 404; `/api/connections` `configured:false`; `/api/mcp` 401 + `WWW-Authenticate`; OAuth metadata 200; DCR register ok; authorize 302.

## Known limits / follow-ups
1. ~~Blocking before connecting Google (taint hardening)~~ — **closed by 79b + fix rounds 1–2** (below); the remaining residuals are listed there under "Known residuals after 79b".
2. Per-calendar event lists cap at 100 (`truncated` flag); free-time window clamps to 62 days (warned).
3. Approval pins are in-process — a restart between approval and send fails closed.
4. First-link race can leave an account without a connection row (re-link fixes).
5. Deferred minors from the SDD ledger: label edge cases (`co.uk`), scope-badge granularity, label drafts not refreshed on remote rename, shared linking spinner, `manage.ts` not scoped by session user (single-user app), impossible offset dates roll over, 1970 fallback for missing `internalDate`.

## 79b — taint hardening (2026-10-06, branch `fix/taint-hardening`)
Closes Known limits §1 for model text in the agent UI (chat, reasoning, voice caption, sessions transcripts) as of fix round 3 — rounds 1 and 2 each claimed this and were each wrong (below). Connecting is unblocked only by accepting the residuals below — notably #6, data at rest rendered by MdView.
- **(a) Cross-turn taint.** `runAgent` seeds the run's taint from the model-visible history: tainted
  at start iff, after `applyHistoryPolicy`, an in-window record of a `taints` tool still carries a
  content result (`historyCarriesTaint`, `tool-history.ts`; same `producedContent` rule as the live
  flip, now also excluding `{ denied }` / `{ proposed }`). Elided (out-of-window), `{ error }` and
  callId-less records don't count. Passed to `buildAiTools` as `initiallyTainted`. Clears after
  `/clear` or once the record scrolls out of the 3-tool-turn window.
- **(b) `egress` → `outbound`,** now also on `create_job`, `edit_job`, `run_job`, `schedule_wake`.
  Cards: web tools keep "Web request after reading your mail"; job/wake tools get "Background work
  after reading your mail" with the job markdown / wake `when` + `prompt` (`run_job` adds the stored
  job markdown via the new `outboundDetail` hook). Headless + tainted → auto-denied. `exec` and
  `send_message` unchanged.
- **(c) `taints`** added to `gmail_draft`, `calendar_write_event`, `calendar_guest_event`,
  `calendar_rsvp`. `calendar_find_free_time` stays untainted (busy blocks only — a deliberate
  deviation from the original §1(c) wording).
- **(d) `proposeWhen?(args)`** on `AgentTool`; `headlessTools` proposes a `run`-class call when it
  returns true. `gmail_draft`: `a => !!a.draftId` (new drafts still run headless). Replay executes
  the real handler.
- **Fix round 1** (review `.superpowers/sdd/79b/review.md`):
  - C1 (round 1, partial): markdown images restricted to `/api/images/…`, link favicons off.
    Round 1's claim "no request" was **wrong**: the parser's security pass only rewrites
    `src`/`href`, and the renderer copied every other attribute/tag — `<style>url()`, `<link>`,
    `style=`, `<video poster>`, `<source srcset>`, `<a ping>`, MDC `{style=…}` all still fetched.
  - I1: the seed recognises records by the global `TAINTING_TOOL_NAMES`, so headless runs see
    calendar_rsvp / calendar_guest_event results.
  - I2: exec skips its allowlist fast path in a tainted run ("Command after reading your mail",
    not allowlistable; headless auto-denies).
  - I2b: `create_skill` / `edit_skill` are `outbound`. M1: edit_job's card shows the post-edit job.
    M3: tests for `{denied}` / `{proposed}` not tainting and capped previews tainting.
  - Gates on the fix round: typecheck 0; `pnpm test` 3400 passed / 1 skipped; `pnpm test:db` 882
    passed; `pnpm build` ok. Mutations (each red, restored via git): C1 prefixes → `['*']` 5 red;
    I1 seed from registry only → 1 red; I2 autoApprove not skipped → 2 red.

- **Fix round 2** (re-review `.superpowers/sdd/79b/rereview-1.md`):
  - C1: an allowlist sanitizer (comark `post` plugin in `markdown-harden.ts`) turns raw HTML and
    MDC attributes off for model text — disallowed tags dropped or unwrapped, attributes
    allowlisted per tag, images only from `/api/images/…` (else alt text, so no spinner either).
    Tested by rendering the REAL `<Markdown>` in happy-dom with the bound props for 16 vectors
    (static + streaming) plus a not-vacuous check that round-1 props still leak.
  - Voice caption (`pages/agent/index.vue`) moved from `MdView` to `MessageResponse`.
  - Browser (:3015 + request-logging listener on :3016, one fixture reply with 8 vectors + a
    freshly uploaded `/api/images` image): pre-fix caption → 8 distinct hits (inline, raw img,
    style, link, div style, poster, srcset, MDC style); fixed chat + caption → 0 hits, bold /
    list / code block / the uploaded image (naturalWidth 64) all render. The browser also caught a
    duplicate `v-bind` in `MessageResponse.vue` that typecheck and unit tests passed (b4e28bc).
  - Gates: typecheck 0; `pnpm test` 3437 passed / 1 skipped; `pnpm test:db` 882 passed; `pnpm build`
    ok. Mutation: sanitizer plugin removed (`plugins: []`) → 21 red (every raw-HTML/MDC vector,
    static + streaming, + the alt-text test); restored via git.

- **Fix round 3** (re-review `.superpowers/sdd/79b/rereview-2.md`): round 2 was still bypassable —
  a ```` ```html ```` fence auto-switched to vue-stream-markdown's HTML previewer
  (`<iframe srcdoc=… sandbox="allow-scripts">`, sub-resources + fetch, zero clicks); the sanitizer
  allowed `pre` and the HTML is code text. `agentMarkdownProps.previewers = false` (the only
  built-in previewers are html and mermaid; no extensions are configured). Six fence vectors
  added (html, HTML, unclosed html, html+style url, svg, mermaid) in static + streaming, a
  not-vacuous check that round-2 props leak through the fence, and "the fence shows as code".
  Mutation previewers back on → 4 red; restored via git. Gates: typecheck 0; `pnpm test` 3451 passed / 1
  skipped; `pnpm test:db` 882 passed; `pnpm build` ok.

### Known residuals after 79b (accepted — none blocks connecting, but know them)
1. **Prose outlives the taint.** The taint clears once the tool record leaves the 3-tool-turn
   window, after `/clear`, or when the summary fold drops the turn — but mail text Bridget quoted
   in her own reply, her reasoning, or the thread summary (prose only) stays in context untainted.
2. **Carry-over into later untainted runs.** `save_memory` (memories are injected into every run,
   headless jobs included), memory enrichment (extracts from conversation content/reasoning),
   `save_document`, `create_task`/`edit_task`, `quick_capture` can store mail text that a later
   run reads without being tainted. Follow-up: tag memories saved in a tainted run and keep them
   out of proactive injection into headless runs.
3. **Headless availability.** A main-thread job/wake that fires while a mail read is still in the
   window has every web/exec/job call auto-denied (`{ denied: true }`), with no other feedback.
4. **`calendar_write_event`** (no guests) runs freely interactively — on a calendar shared with
   others, a tainted run can copy mail text into a title/description they can see.
5. **iMessage `allowedHandles` must be Tony's own identities only** — any allowed handle gets an
   interactive Bridget with free Gmail reads, answered in that person's chat.
6. **MdView renders data at rest unhardened.** Documents (incl. `save_document` output), review
   triage captures (memory extraction, `quick_capture` text), shared docs, and job/skill/config
   markdown (`MarkdownConfigEditor.vue:146` preview — content a tainted run can write after
   approval) render through
   MdView/MDC with no image/HTML restriction — mail text a tainted run saved into one of them
   could exfiltrate (off-origin image, `style=url()`) when Tony opens it. Follow-up: a CSP
   `img-src`/`style-src` backstop, or the same sanitizer for agent-authored docs. No app-wide
   CSP in this change.
7. A job created before any Google read runs headless later; if it reads mail it is tainted
   in-run and its own outbound calls auto-deny.
8. Model text loses raw HTML entirely (e.g. a `<details>` or `<div>` Bridget writes renders as its
   text) and blocked images show as alt text. The sessions transcript view (`TranscriptRow`, also
   `MessageResponse`) gets the same treatment — Claude Code transcripts with raw HTML render as text.

- Evidence: TDD — 26 new/renamed assertions red before the change; gates typecheck 0, `pnpm test`
  3376 passed / 1 skipped, `pnpm test:db` 882 passed, `pnpm build` ok. Mutation checks (each red,
  restored via `git checkout`): seed removed → 2 red in `run-taint.test.ts`; `outbound` dropped on
  `create_job` → 4 red in `ai-tools-taint.test.ts`; `proposeWhen` ignored → 2 red in
  `test/agent-propose-when.test.ts`.

## Tony's setup (DEPLOYMENT.md §20)
GCP project → enable Gmail/Calendar/People APIs → Google Auth Platform (Branding, Audience = External → **Publish app**, Data Access = the 8 scopes, Clients = Web with both redirect URIs) → Workspace admin console: trust the client id **before** the first link → set `NUXT_GOOGLE_CLIENT_ID/SECRET` in `/opt/mymind/.env.native` → restart → Settings → Connections → connect both accounts → acceptance (spec §7).

## Deploy (2026-10-06)
CD 37430349947 on 07d0c4b: success. Prod `/api/health` 200 (in-LXC + external), bundle contains `gmail_send`, `connections` table present, `/sign-in/social` 403, 0 journal errors after cutover, authed MCP canary ok. Wiki mirrored: `agent.md`, `google-connections.md` (new, id abfd2326).
