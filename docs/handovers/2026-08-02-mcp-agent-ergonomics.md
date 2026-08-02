---
title: MCP agent ergonomics — write receipts, typed edit failures, and the file↔MyMind sync primitive (cycle 52)
cycle: 52
date: 2026-08-02
status: ✅ SHIPPED — merged to master (fast-forward `9004300..329f55b`), pushed, and DEPLOYED via CD run 30761974846 (test + deploy both green, exit 0). Prod verified independently, not taken from the green run: LXC 114 `hostname` → `mymind`, `systemctl is-active mymind` → active, DB-touching `/api/health` → 200. Migration 0030 applied cleanly — `information_schema` reports `content_hash` `is_generated = ALWAYS`, `generation_expression = doc_content_hash(content)`, and **112/112 rows** (including soft-deleted) hash correctly. Live prod MCP `tools/list` → **38 tools**, `sync_document` present with all 10 params (content, expected_hash, force, frontmatter, id, local_hash, path, tags, title, type), and `edit_document`'s description advertises both the receipt and the typed errors. Gates at merge: typecheck 0 / test 992 across 136 files / build clean; live E2E 28/28.
branch: feat/mcp-agent-ergonomics (built subagent-driven on the branch — NOT in a worktree; 8 plan tasks (0–7) + 1 pre-flight plan-defect resolution + 2 per-task fix rounds + a final whole-branch fix wave. Per-task briefs/reports, the execution ledger, and `final-fix-report.md` live in `.superpowers/sdd/2026-08-01-file-sync-primitive/` — gitignored working artifacts)
docs:
  - ../wiki/mcp.md (living reference — new "Write receipts + typed edit failures" and "File sync (`sync_document`)" sections; tool table gains `sync_document` and marks the six write tools as returning receipts; updated 2026-07-29→2026-08-02)
  - ../superpowers/specs/2026-08-01-file-sync-primitive-design.md (spec)
  - ../superpowers/plans/2026-08-01-file-sync-primitive.md (plan; amended pre-flight at `d4a54bd` when the CI/DB-test conflict was found — Task 0 added)
  - ../superpowers/plans/00-roadmap.md (cycle-52 row added by this handover)
related:
  - ../handovers/2026-07-29-mcp-recall-hygiene.md (cycle 51 — the paging work whose deploy boundary explains why the external agent's "issue 1" was not a bug)
problem: >
  An external Claude Code session doing heavy doc sync against the MyMind MCP filed four issues
  plus smaller items. Investigated each against the code and live prod before writing anything.
  Two of the four did not survive investigation; one was real and worse than reported; one was
  the right idea and much cheaper to build than its author thought.
---

# MCP agent ergonomics (cycle 52)

## What the external report got right, and what it didn't

The report is reproduced in the conversation that opened this cycle. Verdicts, all verified
independently before any code was written:

| Reported | Verdict |
|---|---|
| **1.** `limit` default not applied when the param is omitted | ❌ **Not a bug.** The reporter straddled a deploy. |
| **2.** Write responses return the whole document, so successful writes surface as errors | ✅ **Real, and worse than reported** — it was also burning the in-app agent's context. |
| **3.** Implemented features missing from the tool schema | ❌ **Premise wrong** — nothing receipt-related existed anywhere. But the underlying worry is structurally impossible here. |
| **4.** No "sync this file into MyMind" primitive | ✅ **Right, and cheaper than estimated** — the storage half already existed. |

### Issue 1 — a deploy boundary, not a defect

`clampPaging()` (`server/lib/agent/paging.ts:9`) defaults to 25 and has a unit test asserting it.
Running the reporter's exact query live with no `limit` returned 25 summary rows, ~4.5 KB.

The real cause: cycle 51's commits `c3d3bb7` + `5e65bf3` (2026-07-30) added the summary DTOs and
the paging envelope; prod's build was `2026-07-31 17:31 UTC`. **Before** that, `search_docs` had
**no `limit` parameter at all** and returned full document rows unbounded. The query has 33
candidate matches; 33 × ~12 KB of body ≈ 398 KB — the reporter's exact number. `search_tasks` was
identical. So the no-`limit` call hit the old build and the `limit: 25` call hit the new one, and
the parameter got the credit for a deploy.

**Nothing to fix. The action is to tell the reporter to reconnect their MCP client** — a cached
pre-07-30 tool list is also the entirety of issue 3.

### Issue 3 — schema drift is structurally impossible here

`server/lib/mcp/server.ts:22` hands `tool.schema` — the same Zod shape the handler destructures —
directly to `server.tool()`. The advertised JSON Schema is generated from the object the handler
reads, so the two cannot diverge. The concern is legitimate in general; it is not a failure mode
this server has.

## Part 1 — Write receipts + typed edit failures (`69acebc`)

**This was a correctness bug, not a cost optimisation.** Document writes echoed the whole document
back. On a large doc that pushed the response past the MCP host's tool-result cap, so a write that
had **already committed** reached the agent as an error — which it would then either retry
(double-applying, or failing on a now-stale `old_string`) or report as failed work.

What the report could not see: the same `agentTools` array backs the **in-app agent**, and
`ai-tools.ts:58` feeds `exec.result` straight into the model's tool-result message. The echo was
burning the local agent's context on every doc write too. Nothing consumes the echoed body — the
UI renders `exec.summary`, and `get_document` already exists for readers — so receipts **replace**
it outright rather than hiding behind an opt-in `return:` mode. (The report proposed the mode; it
was dropped deliberately as a foot-gun an agent would set to `"full"` trying to be careful.)

```jsonc
{ "ok": true, "id": "…", "path": "…", "title": "…", "project": "…", "type": null, "tags": [],
  "updatedAt": "…", "hash": "<sha256 of content>",
  "bytes": { "before": 102010, "after": 102019 }, "replacements": 1 }
```

Applies to `save_document`, `edit_document`, `edit_section`, `update_document`, `move_document`,
`quick_capture`. **Reads are unchanged** — `get_document` still returns the full body on purpose.

Edit failures are typed — `error` is a stable code, `message` the human hint — so an agent branches
on the outcome instead of pattern-matching prose: `no_match`, `ambiguous_match` (with
`candidates: [{line, text}]`), `empty_old_string`, `not_found`.

**Two defects were caught by the tests during this part, both would have shipped otherwise:**
- `ambiguous_match` candidates originally carried full line text, so a 120 KB single-line document
  produced a 120 KB *candidate* — reintroducing the exact overflow receipts exist to prevent.
  Candidates are now 10 distinct lines, each clipped to 200 chars (`clip()` in `edit-ops.ts`).
- The first receipt implementation used `updateDoc(...)!`, which threw a `TypeError` when a row was
  deleted concurrently. Now returns typed `not_found`.

## Part 2 — `sync_document` (the file↔MyMind sync primitive)

Agents were mirroring repo docs into MyMind by hand-replaying N find/replace edits, because there
was no "make this doc match this file" operation. Local files now carry their own MyMind identity
in frontmatter, so sync works identically for git repos, non-git directories, and MyMind-native
docs with no file at all:

```markdown
---
mymind_id: 6d14a9c3-c421-4e49-a162-86536b8f534c
mymind_hash: 189d0cfb…
---
```

### The hash covers the BODY ONLY — this is the design's load-bearing decision

A hash over the whole file including its own frontmatter changes the moment you write the hash back
into that file, so it never converges. This is the one real trap in the naive design.

MyMind's storage made the correct definition free: `documents.content` and `documents.frontmatter`
are separate columns and `content_hash` is already `sha256(content)`. Verified against prod
2026-08-01: only **3 of 103** live documents embed frontmatter inside `content`, and all 103 rows
had a hash matching `sha256(convert_to(content,'UTF8'))` exactly. Both sides hash the same bytes by
construction — no normalisation layer, no backfill.

### `content_hash` became a Postgres generated column (migration `0030_famous_corsair.sql`)

A compare-and-swap on a hash that any writer can silently desynchronise is not safe — and the code
had already broken that promise: `server/services/image-enrich.ts:90` writes `content` via a raw
`db.update(documents)` when re-OCRing an already-linked image, bypassing `updateDoc` and leaving
the hash stale. It had not yet produced a wrong hash in prod only because that path had not re-run
against an existing linked doc.

```sql
CREATE OR REPLACE FUNCTION doc_content_hash(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
ALTER TABLE "documents" DROP COLUMN "content_hash";
ALTER TABLE "documents" ADD COLUMN "content_hash" text
  GENERATED ALWAYS AS (doc_content_hash(content)) STORED;
```

⚠️ **The naive form is rejected.** `GENERATED ALWAYS AS (encode(sha256(convert_to(content,'UTF8')),'hex'))`
fails with `ERROR: generation expression is not immutable`, because `convert_to` is not marked
immutable. The explicitly-`IMMUTABLE` wrapper is accepted — verified on PG 16.11 (local) and the
migration then verified against a throwaway fresh database running all 31 migrations. The wrapper's
immutability holds as long as the server encoding is UTF8, which prod confirms.

The JS hashing in `documents.ts` (two `createHash` calls) is deleted; `$inferInsert` no longer
contains `contentHash`, so a future writer is a **compile error**.

### Tool surface

```jsonc
sync_document({ id?, path?, content?, local_hash?, expected_hash?, force?,
                title?, tags?, type?, frontmatter? })
```

| `action` | Condition | Content write |
|---|---|---|
| `created` | no `id`, `path` matches no live doc | yes |
| `adopted` | no `id`, `path` matches a live doc that already agrees | no — returns its `id` + `hash` |
| `updated` | `expected_hash` matches stored, or `force: true` | yes |
| `unchanged` | incoming content already equals stored | no |

`adopted`/`unchanged` still emit exactly one `updated` event **if** a relocation or metadata patch
rides along. The handler emits `publishChange` exactly once per invocation, never twice.

**Fail-closed.** `hash_mismatch`, `adopt_conflict`, `expected_hash_required`, plus the upfront
misuse guards `path_required` and `content_required`. Each refusal returns a body-free divergence
report (`server.hash`/`bytes`/`updatedAt`/`headings`, `local.bytes`) so the agent can decide without
pulling the document. **Gated adoption** is what stops a first sync from clobbering a doc edited in
the UI — a deliberate deviation from the "adopt-or-create" option as originally chosen, because the
first sync is precisely when the local file is least likely to be authoritative.

**The guard is in the `UPDATE`'s `WHERE content_hash = $expected`, not a preceding `SELECT`** — a
read-then-write would let a concurrent edit slip between the two statements.

**Probe mode**: pass `local_hash` instead of `content` → `{ ok, in_sync, server_hash, id }`, no body
transferred, never writes. The real cost of syncing a 121 KB doc is the upload, and most days
nothing changed.

**Deletes are out of scope** and deliberately so — a sync that deletes on absence is one bad glob
away from wiping the wiki.

## Verification

- **Live E2E 28/28** (`scripts/sync-document-e2e.mjs`) against a real Postgres through the real
  `/api/mcp` endpoint. The load-bearing assertion: **two `sync_document` calls fired concurrently
  via `Promise.all` with the same `expected_hash` — exactly one won, the other returned
  `hash_mismatch`.** That is the only test of the atomic CAS against a real database rather than a
  mock. A 102 KB `save_document` returns a ~300-byte receipt whose hash matches `sha256(content)`
  in Postgres exactly.
- **Prod pre-flight (read-only):** 110 rows, **0 drifted**, 0 null, no dependent index/view/constraint
  on `documents.content_hash`, no name collision on `doc_content_hash`, `server_encoding=UTF8`,
  PG 16.14. The migration recomputes identical values — a data no-op, and no re-embedding wave.
- Reviewers verified by **breaking** things, not reading them: each fixed branch was broken and the
  tests watched go red; the E2E was re-run with a bad token and with an injected mid-run crash to
  prove failures tally and cleanup runs on the failure path.

## Defects the review loop caught that green gates did not

1. **A fake CAS-race test.** The plan's "loses the CAS race" test mutated the row *before* invoking
   the handler, so the pre-read caught the divergence and `casUpdateContent` was called **zero
   times**. The single branch this feature exists to protect had no coverage in 973 tests. Caught by
   instrumenting the mock. **Plan defect, not a build defect.**
2. **A vacuous receipt-size test.** `"keeps the receipt small even when the document is enormous"`
   used `old_string: 'x'` against 120,000 `x` characters → 120,000 matches → `ambiguous_match`, so it
   measured a ~392-byte **error object**, never a receipt. The branch's headline claim was asserted
   nowhere in CI. **Shipped in the first commit; caught by the final whole-branch review.**
3. **`undo` force-overwrote a third party.** It passed `expectedHash: null`, so undoing a sync
   destroyed an edit made in the UI afterwards. Ruled: guard `sync_document`'s undo only (see
   follow-ups for the pre-existing siblings).
4. **A wrong causal story, caught before it set in a comment.** An implementer attributed a
   TypeScript narrowing failure to an intervening `await`; a reviewer reproduced the identical error
   with no `await` present. The real cause is that negating a compound guard isn't retained on a
   property reference once the discriminant is re-narrowed. Fixed by hoisting `const err = …`.

## Deploy window + rollback hazard ⚠️

CD runs `pnpm db:migrate` at the end of the **build** step and `systemctl restart mymind` in the
**next** step, so the old process keeps serving in between (deliberate — it avoids a build-length
outage). The old code explicitly `set`s `content_hash`, which Postgres rejects on a
`GENERATED ALWAYS` column (SQLSTATE 428C9). **Every document create/content-update in flight during
that window will 500.** Seconds long, self-healing at cutover, no data risk.

The sharper edge: **a code-only rollback** (checkout the previous commit and rebuild, without a down
migration) breaks *all* document writes permanently, because the old code would keep trying to write
the generated column. If you roll this back, roll back the migration too.

Also note: a **data-only** restore of a pre-0030 `pg_dump` into the post-0030 schema would fail on
the generated column. A full `pg_dump` restore (what `docs/DEPLOYMENT.md` documents) is fine.

## Known gaps and follow-ups

Tracked as MyMind tasks; none blocks merge.

- **The MCP preamble still steers agents at the old workflow.** `server/lib/mcp/server.ts:13` says
  "Edit in place… `edit_document` … do NOT rewrite a whole document" and never mentions
  `sync_document` — the exact behaviour this cycle exists to replace. Line 14's "All are reversible
  via undo" is also now imprecise. **Highest-leverage single line in the branch and it wasn't
  touched.**
- **Error shapes are still inconsistent** — the unfinished half of this branch's own first commit.
  `edit_document`/`sync_document` return `{ok:false, error:<code>}`; `edit_section`,
  `read_document`, `grep_document`, `update_document`, `delete_document` still return bare
  `{error:'<prose>'}` with no `ok`. `edit_section`/`read_document` also return an **unclipped**
  `outline()` on failure — the same overflow class, in the same file.
- **CI has no coverage of the two things the safety rests on.** DB tests are correctly excluded from
  the gate (`*.db.test.ts`, run via `pnpm test:db`), but nothing runs them automatically, so
  breaking the CAS or the generated column leaves `pnpm test` green. Add a `services: postgres`
  block to the deploy workflow's `test` job.
- **Undo is incomplete on the adopt/unchanged branch** — a rename-only sync (the documented
  "file got renamed, body untouched" case) has no `undo` at all.
- **A relocating sync silently rewrites the title** to the new filename basename
  (`updateDoc:180-181`, pre-existing `move_document` behaviour). A curated "MCP Server" title becomes
  "mcp.md" on the first rename. Neither the tool description nor the wiki mentions it.
- **The 3 prod docs with frontmatter embedded in `content`** can never match a frontmatter-stripped
  body, so they will return `adopt_conflict` forever and the natural escalation (`force: true`)
  destroys the embedded frontmatter. Handle those three by hand before syncing them.
- **`docNotFound` sibling tools** still put whatever they're given in `id`; only `sync_document`'s
  path-addressed miss was fixed (it now uses a `path` field rather than presenting a path as an id).

## Merge checklist

1. `docs/superpowers/plans/2026-06-03-memory-mcp.md` is dirty in the working tree, unrelated to this
   branch — clean or commit it separately so it doesn't ride along.
2. Merge, push, watch CD (`gh run watch <id> --exit-status` — **never pipe to `tail`**).
3. Verify prod: `/api/health` → 200 (DB-touching), and confirm `content_hash` is
   `is_generated = ALWAYS` in LXC 114.
4. Prod MCP round-trip: `tools/list` should show **38 tools** including `sync_document` (37 before
   this cycle; the registry count is pinned by `test/agent-tools.test.ts`).
5. Tell the external reporter to reconnect their MCP client — they will otherwise keep seeing the
   pre-07-30 tool list, which is the whole of their issues 1 and 3.
