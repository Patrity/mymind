---
title: MCP document-tool ergonomics — unified errors, guarded undo, honest preamble
cycle: 53
date: 2026-08-07
status: spec — approved in brainstorm, not yet planned
tasks: ae2d177d, 06ca3a11, 0cb0fcf8, 1a40468a, b717565a
related:
  - ../../handovers/2026-08-02-mcp-agent-ergonomics.md (cycle 52 — filed four of these five)
  - ../../handovers/2026-08-05-structural-tool-history.md (cycle 43 — the vacuous-assertion lesson)
---

# MCP document-tool ergonomics

Five tracked follow-ups against the MCP document tools, all verified against current code before
this spec was written. They share one subsystem and one deploy.

## Problems

**1. The preamble steers agents at the wrong workflow** (`server/lib/mcp/server.ts:13-14`).
It prescribes `edit_document`/`edit_section` and never mentions `sync_document` — the tool cycle 52
built to replace that workflow. It also claims "All are reversible via undo", which problem 4 makes
false in a specific way. This text is in the context of every connecting agent on every session.

**2. Three error shapes coexist across the document tools** (`server/lib/agent/tools.ts`).

| Shape | Tools |
|---|---|
| `{ok:false, error:<code>, message}` | `sync_document` |
| `{ok:false, ...res}` | `edit_document` |
| bare `{error:'<prose>'}`, no `ok` | `read_document` ×2, `grep_document` ×2, `edit_section`, `update_document`, `delete_document` |

`docNotFound` and `docNotFoundAtPath` already exist (`server/lib/agent/receipt.ts:35,46`) and are
used only by `edit_document`. Cycle 52 coded two of `edit-ops.ts`'s six error returns
(`empty_old_string:160`, `no_match:165`) and left four as prose (`:41`, `:42`, `:90`, `:185`).

**3. Failure payloads leak an unbounded outline.** `read_document:25` and `edit_section:18` return
the full `outline()` — one entry per heading, uncapped — inside an *error* result. This is the
oversized-payload class cycle 52 was created to eliminate, still live in the same file.

**4. Undo clobbers concurrent writes** (`tools.ts:299,327`). `updateDoc(id, {content: prior})` runs
unconditionally, so a write that landed after the edit — from the UI, another agent, or
`sync_document` — is silently reverted. `casUpdateContent` (`server/services/documents.ts:210`)
already exists and is unused by undo.

Found while investigating: `runUndo` (`server/lib/agent/undo.ts:25-31`) deletes the token **before**
awaiting the closure, so any undo failure is unrecoverable — and a throwing closure escapes as an
unhandled 500.

**5. A relocation silently rewrites the title** (`server/services/documents.ts:181`). On any path
change without an explicit title, `patch.title = basename(finalPath)`. A curated "MCP Server"
becomes "mcp.md".

**6. `sync_document`'s adopt/unchanged branch registers no undo** (`tools.ts`, sync handler ~line 89)
even though it mutates — `meta.changed` gates a real `publishChange`. The `create` and `write`
branches both register one.

**7. `grep_document` gives no hint on a zero-match regex-looking pattern**
(`server/lib/documents/edit-ops.ts:82-104`).

**8. Three prod documents embed frontmatter in `content`**, so they can never match a
frontmatter-stripped body: permanent `adopt_conflict`, and `force:true` would destroy the
frontmatter.

## Decisions

| Decision | Choice |
|---|---|
| Error shape | **Full unification** to `{ok:false, error:<code>, message:<prose>}`. Accepts a second breaking MCP contract change. |
| Codes live in | **`edit-ops.ts`**, passed through by tools — one vocabulary, one place to extend. |
| Title on move | **Re-sync only auto-titles** — when the current title still equals the OLD basename. |
| Undo on divergence | **Refuse and report.** CAS-guarded; declines with a reason rather than clobbering. |
| Undo contract | **Additive widening** — `Promise<void \| {ok, reason?}>`, so untouched closures keep working. |
| The 3 stuck docs | **Data fix, no code.** |

### Why additive widening rather than a hard contract change

The brainstorm initially considered changing `UndoFn` from `() => Promise<void>` to
`() => Promise<{ok, reason?}>`. That touches **every** `undo:` closure in the registry — memory,
tasks, images, skills, projects, ~18 of them — to fix three document tools. The union type gets the
same user-visible behaviour with the blast radius confined to the three closures that need it:
`runUndo` normalises a `void` return to `{ok:true}`.

### Why the codes live in `edit-ops`, not the tools

`edit-ops.ts` is where the failures originate and it is pure and already unit-tested. Putting the
vocabulary there means adding a code is a one-file change and no tool can invent its own spelling of
`not_found`. Tools pass the code through and supply the receipt shape around it.

## Design

### Error codes

| Code | Origin | Replaces |
|---|---|---|
| `not_found` | `docNotFound` / `docNotFoundAtPath` (existing) | `'document not found'` in `read_document`, `grep_document`, `delete_document` |
| `heading_not_found` | `edit-ops.ts:41` | `heading not found: "X"` |
| `ambiguous_heading` | `edit-ops.ts:42` | `heading "X" is ambiguous (N matches)` |
| `invalid_regex` | `edit-ops.ts:90` | `invalid regex: …` |
| `replace_needs_heading` | `edit-ops.ts:185` | `replace mode requires a heading…` |
| `no_fields` | `update_document` | `'no fields to update'` |
| `empty_old_string`, `no_match` | already coded (cycle 52) | — |

The prose moves to `message`. Nothing is lost; it simply stops being the machine-readable field.
Every affected tool's `description` gains its failure codes, the way `edit_document`'s already
documents `no_match`/`ambiguous_match`.

### Outline clipping

`read_document` and `edit_section` clip the outline in failure payloads to the first **50** headings
plus `outlineTruncated: true`, via a new `MAX_ERROR_OUTLINE = 50` in `edit-ops.ts`.

This is a *different* cap from the existing `MAX_CANDIDATES = 10` (`edit-ops.ts:113`), which bounds
candidate lines on an ambiguous match. 50 is chosen independently: an outline is one short line per
heading, so it stays cheap where a candidate line can be arbitrarily wide, and 50 headings is enough
to orient in a large document without the payload becoming the problem it is meant to report.

Success payloads are unchanged — this is only about error results.

### Undo

```ts
type UndoFn = () => Promise<void | { ok: boolean; reason?: string }>
```

- `runUndo` normalises `void` → `{ok:true}`; returns `{ok:false, reason}` unchanged from the closure.
- **`runUndo` consumes the token only on success.** A refused undo must stay retryable after the
  caller reconciles; deleting first makes "the document changed" a dead end.
- The three **existing** content-restoring closures (`edit_document`, `edit_section`, and the
  `sync_document` `write` branch) guard their restore with `casUpdateContent` against the hash they
  produced, and return `{ok:false, reason:'document changed since the edit — nothing was undone'}`
  on mismatch. A **fourth**, new closure is added by the adopt/unchanged fix below; it reverses
  metadata rather than content, so it needs no CAS.
- `POST /api/agent/undo` returns `{ok, reason?}`.

### `sync_document` adopt/unchanged undo

The branch registers an undo whenever `meta.changed` is true, reversing the metadata/rename it
applied. When nothing changed it registers none — there is nothing to reverse.

### Title on relocation

```ts
const wasAuto = existing.title === basename(existing.path)
if (input.title === undefined && wasAuto) patch.title = basename(finalPath)
```

An explicitly-passed title still wins, as today.

### Preamble

Two edits to `MCP_INSTRUCTIONS`:

1. The "Edit in place" line leads with `sync_document` for the case it exists to serve — an agent
   holding a file — keeping `edit_document`/`edit_section` as the surgical option for documents with
   no file behind them.
2. "All are reversible via undo" becomes accurate: undo exists and now **declines** rather than
   clobbering when the document has changed since.

Length stays roughly as-is. This block costs every connecting agent context on every session.

### Grep hint

When `grepDocument` returns zero matches, `opts.regex` is falsy, and the pattern contains regex
metacharacters, the result gains `hint: 'pattern looks like a regex — retry with regex: true'`.
Success shape only; zero matches is not a failure.

### The three stuck documents

Read each through the MCP, move the embedded block into the `frontmatter` column, leave `content`
body-only, then confirm a probe-mode `sync_document` reports `unchanged`. The plan lists the three
ids so the work is auditable. No code, no migration.

## Testing

- `edit-ops.ts` is pure with 26 existing tests — the code changes land there as unit tests, no DB.
- Tool-level error shape: assert `{ok:false, error:<code>}` per tool, and that `message` carries the
  prose.
- Outline clipping: a document with >50 headings must produce a clipped outline and
  `outlineTruncated: true` in the failure payload.
- Undo normalisation: a `void`-returning closure still yields `{ok:true}` — this is what proves the
  ~18 untouched closures were not broken.
- Token retention: a refused undo leaves the token usable.
- **The CAS guard needs a real database.** It goes in a `*.db.test.ts` run via `pnpm test:db`.
  This does **not** run in CI (see `70bcc740`) — say so in the handover rather than implying the
  gate covers it.
- Every new test gets a mutation check: break the code it guards, watch it go red, revert. Cycle 43
  shipped eight assertions that could not fail; the mutation check caught every one and the green
  suite caught none.

## Non-goals

- `70bcc740` (CI Postgres). Adjacent, and it would give the CAS work above real gate coverage, but
  it is a workflow change rather than a document-tool change.
- `sync_document`'s decision logic (`decideSync`) — untouched.
- `move_document`'s error surface beyond adopting `docNotFound`.
- Any migration. No schema change in this cycle.

## Risks

- **Second breaking MCP contract change in three cycles.** Anything reading `.error` as prose sees a
  code after this deploys. Mitigated by `message` carrying the identical prose.
- **The undo union type is easy to half-adopt.** A closure that returns a result while `runUndo`
  ignores it would silently reinstate the clobbering. The normalisation test is the guard.
- **The CAS path ships without CI coverage.** Known and accepted; `70bcc740` is the fix and stays
  open.
