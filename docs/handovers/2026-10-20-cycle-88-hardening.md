---
title: "Cycle 88 (bounded set): phone layout, stored-markdown exfil hardening, DB tests in CI, first-message branching + branch-aware summary"
cycle: 88
date: 2026-10-20
status: built  # on integ/c88-bounded; whole-branch review + one fix round done; awaiting Tony's merge/push go-ahead
branch: integ/c88-bounded (merges fix/ci-gate, fix/phone-layout, fix/mdview-exfil, feat/first-turn-branching)
merged: false
deployed: false
specs:
  - none (bounded fixes approved in chat 2026-10-20); the cycle-88 architectural spec is ../superpowers/specs/2026-10-20-cycle-88-meeting-prep-routing-data-refresh-design.md (separate, not built here)
wiki:
  - ../wiki/agent.md
  - ../wiki/agent-context.md
  - ../wiki/agent-runtime.md
  - ../wiki/document-spine.md
  - ../wiki/clipboard.md
  - ../wiki/triage.md
migrations:
  - 0090_lying_hitman — conversations.branch_at_root, conversations.summary_leaf_id (+ backfill)
shipped:
  - phone layout for /sessions/[id], /documents, /review, /tasks and the /agent starter chips
  - stored-content markdown/HTML hardening, plus fixes to the agent chat sanitizer
  - DB tests (pgvector:pg16 service) as a required deploy gate; typecheck covers test/
  - POST /api/documents duplicate path → 409; backfill-projects uses shouldRecordLocalPath
  - first-message edit/regenerate (second root), pending-root recovery, branch-aware thread summary
next:
  - Tony approves merge + push; watch the first CI run of the new test:db job
  - mirror the touched wiki pages to MyMind
  - the cycle-88 architectural spec (meeting prep, planning routing, artifact data refresh) awaits approval
---

# Cycle 88, bounded set

Tony approved these in chat on 2026-10-20 ("knock all of these out"; bounded set: "Yes, all"). Four
implementers worked in parallel worktrees, and their branches were merged into `integ/c88-bounded`.
A whole-branch review (Opus) found 0 Critical, 5 Important and 7 Minor. One fix round closed all five
Important findings and four of the Minor ones, and a scoped re-review followed.

## What shipped

**Phone layout** (`fix/phone-layout`)
- `/sessions/[id]` and `/documents` show one pane at a time below `lg`: Transcript | Details tabs, and
  tree ↔ editor with a Files button.
- `/review` cards no longer clip. The `/tasks` "New task" button is icon-only below `sm`. The
  `/agent` starter chips wrap.
- Measured by element bounding boxes at 375×812, and checked unchanged at 1440×900.
- `/voice` is now only a redirect to `/settings/voice`.

**Stored-content exfil hardening** (`fix/mdview-exfil` and review fixes)
- See wiki `document-spine.md` § "Markdown rendering safety". One policy covers every stored render:
  MdView, MarkdownConfigEditor, triage cards, `/share/<slug>` (including SSR) and clipboard HTML.
  - Same-origin images only; any other image renders as a link.
  - A component allowlist with vetted props.
  - No `style`, `on*`, `srcset` or `poster`.
  - `class` filtered against an allowlist, so content can't overlay the page.
  - `user-content-` prefix on ids.
  - Icons only from local collections, with `fallbackToApi: false` app-wide.
- Evidence: a document carrying the exfil vectors made 13 requests to a local listener on the old
  code and 0 on the new. The share page, clipboard view and triage card were each checked the same
  way.
- The agent chat sanitizer gets the same `class`, id and `Object.hasOwn` fixes. A
  `<constructor prototype=x>` tag in a stored message used to crash every render of it.

**CI gate** (`fix/ci-gate`)
- `deploy.yml`'s test job runs a `pgvector/pgvector:pg16` service (the same image as prod), creates
  the extensions, writes a minimal `.env` (as the last step, so it can't reach the build), migrates,
  and runs `pnpm test:db --retry=1`. It is a required gate.
- 18 of 107 DB test files are skipped in CI (`DB_TESTS_CI=1`, a skip-list in `vitest.db.config.ts`)
  because they need `ai_config` or dev-only rows. MyMind task `1e45c544` makes them hermetic.
- `tsconfig.test.json` brings `test/` into `pnpm typecheck`. That surfaced 163 errors, all fixed in
  test files only.
- `POST /api/documents`: a duplicate live path now returns 409.
- `scripts/backfill-projects.ts` uses `shouldRecordLocalPath`.

**First-message branching** (`feat/first-turn-branching` and review fix I4)
- Migration 0090 adds `branch_at_root` and `summary_leaf_id`.
- An edit or regenerate of the first message creates a second root, with a ‹ n/N › pager.
- The pending-root rules are in wiki `agent.md` and in the "PENDING ROOT" block of
  `services/conversations.ts`:
  - only an append that starts a root clears the flag;
  - non-UI turns ignore it;
  - a failed send calls `op: 'restore'`;
  - a flag left pending past 60 s with no run expires on the next read.
- The thread summary is branch-aware: it is injected only when `summary_leaf_id` is on the active
  path.
- Evidence, from a browser run with real model replies:
  - after editing the first message, the model answered "NONE" when asked about earlier messages;
  - the pager showed 2/2, then 1/2, then 3/3 after a regenerate;
  - all 3 roots were kept in the database.

## Rulings
- **R1 (I5).** The DB tests are a *required* deploy gate with `--retry=1`, not a separate
  non-blocking job. Cost: an unhandled-error flake (ECONNRESET seen once locally) fails the deploy
  until fixed.
- **R2 (I4).** An event appended while a first-message edit is pending lands on the old branch; it no
  longer consumes the edit. This reverses the first implementer's behaviour. Cost: none expected.
- **R3.** Remote images in stored content render as links rather than click-to-load placeholders.
  Cost: one extra click.

## Open and deferred
- Migration 0090's backfill scales with thread length. It is safe and idempotent at today's size.
- The root race: a reply still persisting can turn a first-message edit into a continuation of the
  old branch. This race already existed at non-root levels.
- `op: 'restore'` after a failed non-root edit lands on the newest branch tip, not necessarily the
  one Tony was reading.
- The conversation GET can run one guarded UPDATE to expire a pending root.
- External `#heading` deep links to shared pages now need `#user-content-<heading>`.
- There is no app-wide CSP backstop yet.
- `test:db` on the shared dev DB shows timing-dependent failures in a few files, which differ from
  run to run and pass in isolation.
