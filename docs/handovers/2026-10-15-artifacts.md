---
title: "Artifacts — Bridget publishes sandboxed static pages and webapps at /artifact/<slug>/ (cycle 87)"
cycle: 87
date: 2026-10-15
status: shipped  # pushed 8fb4d073, deploy run 38946716134 green on the Mac mini 2026-10-16; post-deploy workspace publish + UI pass still open
branch: feat/artifacts (deleted after merge; merge-base master 2cb28f7)
merged: true
deployed: true
specs:
  - ../superpowers/specs/2026-10-15-artifacts-design.md
plans:
  - ../superpowers/plans/2026-10-15-artifacts.md
wiki:
  - ../wiki/artifacts.md
migrations:
  - 0089_sleepy_goblin_queen — artifacts, artifact_versions
shipped:
  - artifacts + artifact_versions tables (soft delete, live-slug unique index, per-version manifest jsonb)
  - pure artifact library (paths, slugs, limits, content-type allowlist, manifest lookup/merge/in-place data diff, HMAC view tokens) + transactional service
  - /artifact/** serving route with CSP sandbox, ACAO *, nosniff, no-referrer, cache, ETag/304, HEAD/OPTIONS on every response
  - private access by 12 h path token minted from the session (subresources carry no cookie, verified)
  - workspace_path publishing from the sandbox (in-container walk/read, secret masking, skipped types)
  - toolset artifacts - publish_artifact, edit_artifact, list_artifacts (shared/MCP), delete_artifact (bridgetProfile only); every publish outbound in a tainted run (R9, approval card shows target/files/entry HTML), headless public html proposed, headless public workspace_path refused (R10), replay marker (conversationId), undo
  - /artifacts and /artifacts/[id] pages, sidebar entry, chat card, live updates
  - eval case artifact-publish-chart in bridget-core
deferred:
  - blob GC for deleted/replaced/failed artifacts (spec 10, out of scope)
  - live query API, backends/server code, per-artifact domains, list thumbnails, comments (spec 10)
  - the deferred-minors list below (BACKLOG.md "Cycle 87 backlog")
next_seam: merge feat/artifacts, deploy (see Deploy notes), then a prod smoke - publish a private page, open via /artifacts, confirm Pangolin does not gate /artifact/**
---

# Artifacts (cycle 87)

Bridget could build code in her sandbox (cycle 82) but had nowhere to show it. She can now publish a single
page or a built webapp as a versioned **artifact** and Tony opens it at `/artifact/<slug>/`, public or private,
in a browser sandbox with no access to MyMind. Current-state reference: [`wiki/artifacts.md`](../wiki/artifacts.md).
Spec (intent): [`2026-10-15-artifacts-design.md`](../superpowers/specs/2026-10-15-artifacts-design.md).

**Status: built, E2E-verified, final fix wave applied (R9/R10), not merged, not deployed.** Gates on the last commit before docs: typecheck exit 0,
`pnpm vitest run` 408 files / 4994 passed (1 skipped), `pnpm test:db service.db.test.ts` 14 passed, `pnpm build` exit 0
(at Task 10; the Task 10b fix wave re-ran typecheck/vitest/db tests). Final fix wave: typecheck exit 0, vitest 408 files / 5010 passed (1 skipped), `service.db.test.ts` 14 passed; build not re-run.

## What shipped, by task
1. Library: `limits`, `manifest`, `html-warnings` (+ schema, migration 0089).
2. `serve.ts`: pure request decisions (headers, URL parse, redirect/token/SPA rules).
3. `token.ts`: HMAC view tokens.
4. `service.ts`: publish (create / in-place data update / no-op / new version), edit, rollback, soft delete/restore, race retry.
5. The route `server/routes/artifact/[...rest].ts`.
6. `workspace-bundle.ts`: container walk + chunked reads + secret masking.
7. Agent tools, gate wiring, toolset, judge `outboundWhen`.
8. API + `useArtifacts` + live bus.
9. UI pages, `Frame`, `ChatCard`, nav, login redirect.
10/10b. E2E proof + fix wave. 11. Docs. Final fix wave: R9, R10, detail-form sync after save (`formSyncFor`), unknown-slug login parity, uuid-shaped slugs rejected, accent-stripping slugs, `?project=` uuid validation.

## Rulings that changed or refined the spec (shipped behaviour)
- **R1** error codes gained `bad_input` and `refused`. **R2** `rootAbsoluteRefs(html, paths)` checks the entry HTML only when the entry is among the files it was given. **R3** `edit_artifact` returns the same ok-shape as publish so the chat card renders for both.
- **R4** workspace publish **skips** non-allowlisted file types and warns (Vite dists carry `.webmanifest`/LICENSE/`.gz`) instead of failing the publish.
- **R5** public publish over **MCP is ungated** (Tony's own authenticated clients, no taint model, same as flipping the UI switch). `workspace_path` is refused over MCP. `delete_artifact` is never on MCP (lives on `bridgetProfile`; `test/mcp-dangerous.test.ts`).
- **R6** (superseded by R9 and removed) a tainted run targeting an already-public artifact without `public` was refused with `ok:false`.
- **R7** `Access-Control-Allow-Origin: *` (no credentials) on every artifact response and an OPTIONS answer, found in Task 9: the opaque origin makes the page's own `fetch('./data/x.json')` cross-origin.
- **R8** inserted Task 10b before the docs so they describe final behaviour.
- **R9** (final review Critical: zero-click exfil) `publish_artifact` is statically `outbound`: its HTML/JS runs as soon as the chat card's iframe mounts, so in a **tainted** run every publish (private too) needs Tony's approval and a tainted **headless** publish is auto-denied. `edit_artifact` is outbound for `public: true` or `rollback_to`. `outboundDetail` puts the target (exists? public?), source kind, ≤ 20 file names and the first 2 000 chars of inline entry HTML on the card. Consequence: design data-refresh jobs to avoid tainting reads (a job that read mail or got a guard-flagged `web_fetch` cannot publish).
- **R10** the web process replays approvals in `remote` execution mode, which cannot read a workspace, so a headless `public: true` publish with `workspace_path` is **not proposed**: it returns `ok:false` "publish it privately first (omit public), then ask to make it public with edit_artifact — Tony approves that". Flow: private publish (runs) -> `edit_artifact public: true` (proposed) -> approve. The `workspaceId` replay pin was removed (dead); proposals pin only `conversationId`, honoured under `ctx.replay` alone.
- 403 (not 404) for an invalid/expired token on a subresource: spec section 5 mandates it. This is a known slug-existence oracle (an unknown slug 404s), accepted because slugs are not secrets; navigation does NOT leak it (unknown and private slugs both 302 to login).
- Off-list edits accepted in Task 7: `gate.ts` `APPEND_TOOLS`, `profile.ts`, `judge/rules.ts` (`outboundWhen`), `types.ts`.

## Verification evidence (Task 10 / 10b, dev rig :3086)
- **Isolation proof (private fixture, logged in, top level and detail-page iframe).** CSP on: `cookie=threw localStorage=threw origin=null api=blocked`, `data={"value":7}`. Mutation `ARTIFACT_CSP = ''`: `cookie` readable, `localStorage=ok`, `origin=http://localhost:3086`, API status 200. Restored with `git checkout`; back to blocked. The test bites; mutation never committed.
- **Cookie finding.** With a temporary log in the route (reverted): the document navigation carries the better-auth cookie, but `/~T/app.js` (dest script) and `/~T/data/x.json` (dest empty) do **not**, both top-level and in the iframe. The path token is required; spec section 5 stands.
- **CORS fix** (R7) re-verified: the private fixture's `fetch('./data/x.json')` renders in the iframe.
- **Real agent run** (Qwen 3.8 Flash Next via LiteLLM, worker): `load_toolsets(artifacts)`, `publish_artifact` first try errored on an absolute path, second published `vite-demo` v1; the chat card rendered the app; `/artifact/vite-demo/settings` (navigation) rendered "Settings" via SPA fallback; `fetch()` of the same URL is 404 by design. A data update to 42 first silently no-oped (`files:{}` + `merge:true` reported "updated in place" 4 times), an explicit retry worked with versions still 1. Both product bugs fixed in 10b (`files:{}` counts as absent; zero sources -> error; service rejects empty files).
- **Logged out:** public renders with all four isolation checks blocked; private -> `/login?redirect=/artifact/iso-private/` -> after login lands on `/artifact/iso-private/~T/` rendered.
- **Eval** `pnpm eval bridget-core --case artifact-publish-chart --n 3`: 2/3 before the 10b tool-description fix (reply omitted the URL), **3/3 (mean 1.000)** after. Small nondeterministic model, 3 samples.
- Seeded rows hard-deleted; the leftover `tmva4avrb-race-new` dev row from the DB test was removed and the test now cleans by slug prefix.

## NOT verified
- The 10b UI changes (iframe remount on version change, dirty-aware form re-sync, `Frame` `version` prop) have unit coverage only for the sandbox constant; no playwright pass of editing while a rollback/refetch lands. The docs task made no browser pass either.
- Nothing ran on prod: Pangolin/Cloudflare behaviour, the prod storage backend, prod secret store, and the 60 s public cache are untested.

## Prod smoke (2026-10-16, after deploy run 38946716134)
- `/api/health` 200. Logged-out navigation to an unknown slug returns the route's own 302 to `/login?redirect=/artifact/<slug>/` with the CSP sandbox, `ACAO *` and `private, no-store` headers, so Pangolin does **not** SSO-gate `/artifact/**` and the `artifacts` table exists (migration 0089 applied; the lookup ran). A subresource request for an unknown slug returns 404.
- Still open: a real `workspace_path` publish on the mini and a logged-in browser pass (form sync, iframe remount).

## Deploy notes
- Run migration **0089** (CD runs `pnpm db:migrate`; verify `artifacts` and `artifact_versions` exist).
- `BETTER_AUTH_SECRET` must be set in the web **and** worker env (already present on prod). Unset -> the route answers 500 for private artifacts and `signViewToken` throws.
- **Check Pangolin does not SSO-gate `/artifact/**`.** Public artifacts must be reachable logged out, and the sandboxed subresource requests (no cookie) must not be redirected to an auth page. Verify with `curl -I https://brain.costanzoclan.com/artifact/<public-slug>/` after the first public publish.
- **Prod is the Mac mini now** (cycle 86, merged after this branch was built: launchd `com.mymind.web`/`com.mymind.worker`, central Postgres at `.80`; see the prod-deploy skill). The E2E above ran against the cycle-82 Docker sandbox; at merge the bundle reader was re-pointed at the native workspace runtime (`workspacePath()` maps `/workspace/dist` → `dist`, since the new PRELUDE refuses absolute paths; `runTaintMode` `unverified` → offline read) and is unit-tested only — re-run a `workspace_path` publish on the mini after deploy. There is still no workspace upload API; Bridget builds the `dist` herself with `bash`.
- Dev-rig note: logging in on a spare port needs `BETTER_AUTH_URL=http://localhost:<port>`.
- Blobs share the existing storage backend; there is no GC, so watch disk if Bridget republishes large bundles often.
- Roll back: set the artifact private or delete from `/artifacts`; the route itself is inert without rows.

## Deferred minors (from the ledger; mirrored in BACKLOG.md)
- T1: `ext()` maps dotfiles like `.js`; no per-path length / control-char limit.
- T2: a root file named `~x` is unreachable (parsed as a token); "25 MB" message hardcoded.
- T3: token test has a filler assertion, no sig-flip / `now === exp` boundary test, default-secret path untested.
- T4: a publish that loses the lock to a concurrent slug rename falls into the create path; `restoreArtifact` emits `created`; no tests for single-file `too_large`, once-after-commit `publishChange`, entry/spaFallback-only change -> new version, summed-bytes pre-put branch; the new-slug race test is probabilistic.
- T5: route test resolves h3 via nuxt->nitropack (brittle); `HEAD` on a missing blob returns 200.
- T6: masking is literal-only and text-types-only; read-script realpath->open TOCTOU inside the container; forged-list malformed cases assert only `instanceof`.
- T7: `rootAbsoluteRefs` misses unquoted attrs; republish overwrites `conversationId` and undo does not restore it.
- T8: view-url query key nested under `['artifact', id]` refetches/mints a token on every update event; detail must be keyed by uuid.
- T9: dates use browser-local `toLocaleString` (accepted); every chat card mints a view-url and mounts an iframe; rollback has no confirm.
- R7: `OPTIONS` returns 204 for any `/artifact/**` path before slug parse (harmless).
- Ops notes: after a public -> private flip, Cloudflare/Pangolin may serve the cached public files for up to 60 s; a private iframe open > 12 h stops loading relative assets (token TTL, 403) until reloaded.
- Final fix wave: the approval card's lead line comes from `ai-tools.ts`'s generic background-work wording ("sets up work that runs later"), which fits a publish only loosely; the `outboundDetail` first line states the real risk.
