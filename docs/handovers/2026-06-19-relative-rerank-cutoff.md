---
title: Relative Rerank Cutoff — top-k + relative band replacing the fixed absolute floor
cycle: 33
date: 2026-06-19
status: shipped
branch: worktree-rerank-relative-cutoff
task: 96ffb5bb
spec: ../superpowers/specs/2026-06-19-relative-rerank-cutoff-design.md
plans:
  - ../superpowers/plans/2026-06-19-relative-rerank-cutoff.md
wiki:
  - ../wiki/search.md
shipped:
  - "**`rankCandidates` cutoff rework** (`server/lib/search/rank.ts`) — replaced the fixed absolute `rerankCutoff` with a per-query **top-k + relative band**: reranked candidates are sorted, kept iff `lexicalExact || score >= relBand × topScore` (relative to the query's OWN top hit → robust to the reranker's length-dependent absolute scale), then capped to `topK`. Fallback path (no reranker) unchanged synthetic RRF score, sorted, capped to `topK`, no band. Signature `cfg: { topK, relBand }`. (9 unit tests)"
  - "**Config** (`server/lib/search/config.ts`) — `SearchRelevanceConfig` drops `rerankCutoff`; adds `rerankTopK: 12`, `rerankRelBand: 0.6`. `cosineFloor`/`candidatesPerLane`/`maxCandidates` unchanged. (2 unit tests)"
  - "**Call-site** (`server/services/search.ts`) — `searchAll` passes `{ topK: cfg.rerankTopK, relBand: cfg.rerankRelBand }`. One line; empty-rerank guard unchanged."
  - "**Empty state is now retrieval-based** — a non-empty candidate pool always yields ≥1 hit (the top clears its own relative band), so `hits=[]` ⟺ the lanes returned nothing. No score-gating (gibberish queries score high, so a score-based empty test is unreliable). No new code; falls out of removing the absolute floor."
  - "Inline TDD, 2 tasks. Gates: **typecheck 0 / test 455 / build**. No palette change (server bounds the list to `rerankTopK`)."
---

# Relative Rerank Cutoff (cycle 33)

A small follow-up to cycle 32. Cycle 32 shipped a **fixed absolute** `rerankCutoff: 0.2`;
verified against the rig, the reranker's score scale is **length-dependent** (same content
~0.29 @46 chars vs ~0.50 padded to ~600 chars), so a fixed floor over/under-trims by passage
length. This replaces it with a per-query **top-k + relative band** anchored to the query's own
top hit. Full behaviour: [wiki/search.md](../wiki/search.md).

## How it was built
Brainstorm → spec → plan → **inline** execution (executing-plans), in an isolated worktree
(`.claude/worktrees/rerank-relative-cutoff`). User-approved decisions: cutoff = top-k + relative
band; empty state = best-guess (retrieval-based, not score-gated). Pure-logic change, fully
unit-tested; no UI/schema/contract change.

## Companion infra (homelab, done in parallel — not this repo)
- The `:8883` reranker shim was set to **fp16** (was silently fp32; VRAM 5.1 → 2.5 GB).
- The model was upgraded **`Qwen3-Reranker-0.6B-seq-cls` → `mixedbread-ai/mxbai-rerank-large-v2`**
  (1.5B). The 0.6B *inverted* technical/entity queries (verified: "Intel X550" → relevant 0.107,
  lowest, even at equal length). The 1.5B ranks correctly and lands relevant docs at a reliable
  **~1.0** (verified length-robust). Irrelevant docs still scatter 0.0–0.9 (not "≈0"); gibberish
  queries score high — which is exactly why the relative band (anchored to the ~1.0 top) is the
  right cutoff and why emptiness is retrieval-based, not score-gated.

## Reranker facts (verified, supersede earlier notes)
- Cohere-compatible shim; `/rerank`, `/v1/rerank`, `/v2/rerank` return identical scores (provider
  `baseURL` carries the prefix). The **`model` field is ignored** by the shim. The cycle-32
  "miscalibrated / cat-photo > runbook / gibberish→0.999 / model-required" claims were **test
  artifacts** (varied input text/length; `model`-less diagnostic curls) — retracted.

## Pending acceptance / to enable in prod
- **The reranker is still UNASSIGNED in prod.** This cycle only makes the cutoff scale-robust; the
  relative band only *engages* once a `rerank` model is assigned. With rerank off, the sole visible
  effect is the palette returning ≤ `rerankTopK` (12) instead of ≤ `maxCandidates` (50).
- **To turn it on (user, task 96ffb5bb):** `/settings → AI` → assign `mxbai-rerank-large-v2` to the
  `rerank` usage (provider baseURL `http://192.168.2.25:8883`), then **live-validate on the real
  prod corpus** (e.g. "Intel X550" surfaces the right doc at top, noise trimmed) and tune
  `rerankRelBand` / `rerankTopK` via the `search_relevance` settings key. This is the live E2E that
  was *not* run this cycle (the new behaviour is dormant until enabled).
- No migration (config is a settings key). `master` auto-deploys.

## Deferred follow-ons
- Rerank the MCP `search_docs` / `search_passages` (agent-facing) — only the cosine floor reaches
  them today.
- Contextual BM25 over chunk text; a `/settings` relevance-tuning UI tab for `search_relevance`.
