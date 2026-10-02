---
title: Memory review gate + readable triage cards + doc-candidate duplicate guards (cycle 77 follow-on)
cycle: 77
date: 2026-10-02
status: deployed
branch: master
merged: true
deployed: true
builds_on: 2026-10-01-memory-dual-scoring.md
wiki:
  - ../wiki/memory.md
  - ../wiki/triage.md
migrations:
  - 0065 memories gains review_gate_pending boolean not null default false (additive; existing rows false)
prod_data_changes:
  - 260 memories soft-archived, marker archived_at = '2026-10-02 00:00:07.77+00' (ids in gitignored scripts/data/both-flag-ids-2026-10-02.txt on Tony's Mac; prod pre-gate dump /root/db-backups/pre-review-gate-20261002T0324.sql.gz)
labels: scripts/data/memory-quick-labels-2026-10-02.jsonl (30 rows, gitignored)
mymind_task: 992149a1-eed7-44f6-9c2f-a5a1ae5a3d7c
mymind_id: 20779321-9e6a-4a65-9547-f9261c0d153f
mymind_hash: 6e01804564fc3250868716442dd112d7159f498f14123ab0b8ed8e3f3c5c97a1
---

# Memory review gate (2026-10-02)

## Analysis (prod export, 2,416 live memories, read-only)

| | Jev keeps | Jev flags (transient ≥ 0.6) |
|---|---|---|
| Audit keeps | 1,454 | 164 |
| Audit flags | 532 | **259** |

- Extraction confidence: r=0.13 vs audit, 0.08 vs Jev; 80% sit in 0.85–0.95. Uninformative.
- Audit is bimodal (0.1 / ~0.9), flags 32%. Jev audit correlation r=0.35.
- 69/2,416 memories were ever retrieved; 4 of the 259 both-flag rows.
- Tony's blinded labels on disagreements (`pnpm label:quick`): kept 12/15 audit-only flags, 14/15
  Jev-only flags. The lone-audit flags he agreed with were dated event logs.

## What shipped

1. **260 both-flag rows soft-archived** on prod (259 at the dry run + one memory created between
   dry run and run). One-statement undo by the marker timestamp (see frontmatter / wiki).
2. **Review gate** — `server/lib/memory/review-gate.ts` (pure decision) + `applyReviewGate` in
   `server/services/memory-scoring.ts`; `insertFresh` auto-reviews and sets `review_gate_pending`.
   Hold (back to `/review`) only when both scorers flag. Details in the wiki *Review gate* section.
3. `pnpm label [set]` takes a set name; new one-keypress `pnpm label:quick [set]`.

Not done, by decision: audit-v3 (a lone audit flag no longer triggers anything, so tuning it buys
nothing now); a gate on `save_memory` (keeps the confidence threshold).

## Triage cards + doc-candidate duplicates (same day, Tony: "the triage cards tell me nothing")

The 8 pending prod triage cards were all doc-candidate Notes; the card showed only a destination path,
never the captured text, and an Append never named its target (picked at click time). 2 of the 8 were
re-tellings of mirrored handovers.

- `/review` triage card shows the capture's text and each action as a sentence
  (`app/components/review/TriageAction.vue`); feed widened by `withTriageContext`.
- Append targets are chosen when queued (`targetDocId` stored) — Approve appends to what was shown.
- Doc-candidate guards: skip all of a session's candidates when it wrote repo docs / MyMind docs
  (`routeSessionDocCandidates`, `sessionWroteDocs`); skip one when an existing doc scores ≥ 0.65
  (`DOC_CANDIDATE_DUP_FLOOR`, `nearestDocument`).
- Browser-validated on dev (playwright-cli): a note card and an append fixture; clicking Approve
  appended exactly the shown block to the named doc and removed the capture.
- Not changed: the 8 pending prod cards stay for Tony to decide (2 are the duplicates — reject them).
  Reject still leaves the capture in `/input`.

## Gates

typecheck ✓ · `pnpm test` 3092 ✓ · `pnpm test:db` 862 ✓ (4 new gate DB tests + 8 unit) · build ✓.
Triage/dedupe follow-on: `pnpm test` 3096 ✓ · `pnpm test:db` 867 ✓ · build ✓; mutations (guard off,
queue-time target off) each turn their test red.
Mutation check: flipping `hold`→`pass` turns 2 gate DB tests red.

## Follow-ups

- Watch `/review` for held memories over the next weeks. If Tony drops nearly all of them, make
  `hold` archive instead.
- Optional: an explicit "dated event log" rule in the audit/extraction prompt.
- The 2026-09-22 labelling harness (`pnpm label`) asks three questions per row; too heavy for Tony —
  prefer `label:quick` for future calibration.
