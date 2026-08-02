---
title: File↔MyMind sync primitive — self-describing files, content-hash CAS, probe mode
date: 2026-08-01
status: draft
supersedes: []
related:
  - server/lib/agent/tools.ts
  - server/lib/agent/receipt.ts
  - server/services/documents.ts
  - server/services/image-enrich.ts
  - server/db/schema/documents.ts
  - shared/types/documents.ts
  - docs/wiki/mcp.md
---

# File↔MyMind sync primitive

## Problem

Many MyMind documents are copies of files that live elsewhere — repo wikis, handovers, spec
mirrors. There is no operation for "make this doc match this file", so agents simulate one with
N hand-replayed find/replace edits. That is where both the cost and the drift come from.

Origin: an external coding agent (Claude Code) doing heavy doc sync against the MyMind MCP
reported ~18 edits across 4 documents in a single session. The shape of the work — locate,
replay, verify — is inherent to not having a sync primitive, not to the agent doing it badly.

The document set is heterogeneous and a fix must not assume otherwise:

- some docs mirror files in a git repo,
- some mirror files in directories that are not version-controlled,
- some are MyMind-native with no file at all.

## Approach

The local file carries its own MyMind identity in frontmatter, so it is self-describing
regardless of where it lives:

```markdown
---
mymind_id: 6d14a9c3-c421-4e49-a162-86536b8f534c
mymind_hash: 189d0cfb…      # body hash as of last sync
---
```

Sync becomes uniform across all three cases: read the file, resolve the target, push the body
under a compare-and-swap, write the returned id/hash back. It survives renames and moves,
requires no path or title matching, and behaves identically inside and outside git.

MyMind cannot read the caller's filesystem, so the agent carries the bytes. This is therefore an
MCP tool, not a server-side crawler. A batch CLI was considered and rejected for now: it would
call this same endpoint, and it adds a second artifact to install, version, and authenticate on
every machine. Revisit only if per-file calls prove too slow in practice.

## The hash contract

**`mymind_hash` covers the document body only. Frontmatter is excluded.**

This is the one genuine trap in the naive design. If the hash covers the whole file including
its own frontmatter, then writing the hash back changes the hash, and the value never converges.

MyMind's storage makes the correct definition free: `documents.content` and
`documents.frontmatter` are separate columns, and `content_hash` is already
`sha256(content)`. Verified against prod on 2026-08-01: only 3 of 103 live documents embed
frontmatter inside `content`, and all 103 rows have a `content_hash` that matches
`sha256(convert_to(content,'UTF8'))` exactly. Both sides therefore hash the same bytes by
construction, with no normalisation layer and no backfill.

Wire format is **full content**, not a diff. The CAS already provides conflict safety; a diff
would add fuzzy-apply as a second failure mode and a second code path. `edit_document` remains
the cheap incremental path for small changes to a large doc, and probe mode (below) removes the
cost argument for the no-op case, which is the common one.

## Hash integrity — generated column

`content_hash` is currently maintained in JavaScript inside `createDoc`/`updateDoc`. That is a
promise the code has already broken once: `server/services/image-enrich.ts:90` writes `content`
via a raw `db.update(documents)` when re-OCRing an already-linked image, bypassing `updateDoc`
and leaving `content_hash` stale. It has not yet produced a wrong hash in prod only because that
path has not re-run against an existing linked doc.

A compare-and-swap built on a hash that any writer can silently desynchronise is not safe. So
correctness must not depend on remembering:

```sql
create function doc_content_hash(t text) returns text
  language sql immutable parallel safe strict
  as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;

alter table documents
  drop column content_hash,
  add  column content_hash text generated always as (doc_content_hash(content)) stored;
```

Verified against the local PG 16.11 on 2026-08-01: a bare
`generated always as (encode(sha256(convert_to(content,'UTF8')),'hex'))` is rejected with
`generation expression is not immutable` because `convert_to` is not marked immutable; the
explicitly-immutable wrapper is accepted, and a raw `UPDATE` that "forgets" the hash still
yields a correct one. The wrapper's immutability holds as long as the database encoding is UTF8,
which it is.

Consequences: the `createHash` calls in `server/services/documents.ts` (lines 153 and 189) are
deleted, `image-enrich.ts` needs no change, and any future writer is correct by default.

## Tool surface

```jsonc
sync_document({
  id?:            string,   // from the file's mymind_id
  path?:          string,   // required when there is no id; also relocates when id is given
  content?:       string,   // the file body, frontmatter stripped; omitted in probe mode
  local_hash?:    string,   // probe mode only — the body hash, with no body
  expected_hash?: string,   // from the file's mymind_hash
  force?:         boolean,  // proceed despite divergence
  title?, tags?, type?, frontmatter?   // optional metadata passthrough
})
```

Returns the `DocReceipt` shape shipped on 2026-08-01, plus an `action`:

| `action` | Condition | Writes |
|---|---|---|
| `created` | no `id`, `path` matches no live doc | yes |
| `adopted` | no `id`, `path` matches a live doc whose content already equals `content` | no — returns its `id` + `hash` |
| `updated` | `id` present and `expected_hash` matches stored; or any divergent write forced with `force: true` (including a forced adoption) | yes |
| `unchanged` | incoming content hashes equal to stored | no, and no `publishChange` |

**`expected_hash` is mandatory whenever the target already exists.** An `id` with no
`expected_hash` is refused with `error: "expected_hash_required"` unless `force: true` is set —
otherwise the parameter that makes this safe would be optional in exactly the case it protects.
It is correctly absent only when creating.

Target resolution is deterministic: `id` wins; otherwise `path` is looked up against the
existing unique index on live document paths. No fuzzy or title-similarity matching.

`project` is not a parameter. `path` determines it through the existing cycle-26 path⟺project
choke point, so filing a mirror under `/projects/<slug>/…` associates it automatically. Passing
`path` together with `id` relocates the doc, which is what makes a renamed or moved local file
converge rather than fork.

## Conflict handling

Writes fail closed. The tool never overwrites a divergent server copy without `force: true`.

```jsonc
{ ok: false, error: "hash_mismatch",
  server: { hash: "7656a55b…", bytes: 102019,
            updatedAt: "2026-08-01T22:12:10Z",
            headings: ["Overview", "Endpoint", "Authentication"] },
  local:  { bytes: 98110 },
  hint:   "inspect with read_document, then re-call with force:true" }
```

The report is deliberately body-free — enough for the agent to decide whether to inspect,
without pulling the document. It reuses `outline()` from `edit-ops.ts` for `headings`.

**Adoption is gated the same way.** When `path` matches an existing doc and its content differs
from the incoming body, that is divergence and requires `force: true`. Without this, the very
first sync of an existing mirror would silently clobber whatever is in MyMind — including edits
made in the UI. When the mirror is already current, adoption still resolves in one call.

The CAS is atomic, not check-then-write:

```sql
UPDATE documents SET content = $new WHERE id = $id AND content_hash = $expected AND deleted_at IS NULL
```

Zero affected rows means conflict-or-missing, disambiguated by one follow-up read. The existing
write handlers do `getDoc` then `updateDoc`, which is already racy; this is strictly better.

## Probe mode

Passing `id` + `local_hash` with **no** `content` answers whether the two sides agree, without
transferring a body:

```jsonc
→ { ok: true, in_sync: false, server_hash: "7656a55b…" }
```

Probe answers with `in_sync` and `server_hash` only — it deliberately does not return an
`action`, since those describe writes and probe performs none.

This exists because the real cost is the upload. Syncing a 121 KB timeline means putting 121 KB
into tool input every time, even on a day nothing changed — and "nothing changed" is the common
case. Probe turns a routine "is everything synced?" sweep into a few hundred bytes per file.

Probe never writes.

## Out of scope

**Deletes.** A deleted local file will not remove its MyMind document. A sync primitive that
deletes on absence is one bad glob away from wiping the wiki; retirement stays deliberate via
`delete_document` (which is soft and undoable). This is a deliberate asymmetry, not an
oversight.

**Server→file direction.** This design pushes file→MyMind and reports divergence in the other
direction, but never writes to the filesystem. The agent owns local writes.

## Testing

- `edit-ops`-style pure unit tests for target resolution and action selection.
- Handler tests with a mocked documents service, mirroring `test/agent-doc-receipts.test.ts`:
  each of the four actions, both conflict paths, gated adoption, probe mode, and that
  `unchanged`/`adopted`/probe emit no `publishChange`.
- A migration test asserting the generated column rejects drift: write `content` via a raw
  update and assert `content_hash` still matches.
- Live E2E through the real `/api/mcp` StreamableHTTP endpoint against a real database, as done
  for write receipts on 2026-08-01 — unit tests with a mocked DB cannot prove the CAS actually
  races correctly.

## Prerequisites already shipped (2026-08-01)

- `contentHash` exposed on `DocumentDTO` (`shared/types/documents.ts`, `toDTO`).
- Body-free `DocReceipt` on all six document write tools (`server/lib/agent/receipt.ts`).
- Typed edit failures (`no_match`, `ambiguous_match`, `empty_old_string`, `not_found`).
