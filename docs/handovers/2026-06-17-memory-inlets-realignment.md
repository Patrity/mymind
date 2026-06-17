---
title: Memory inlets realignment — save_memory confidence + concise-only guidance
cycle: 27-followup (operational)
date: 2026-06-17
status: shipped
relates:
  - 2026-06-03-memory-mcp.md
  - 2026-06-16-prod-rollout-and-memory-quality.md
wiki:
  - ../wiki/memory.md
  - ../wiki/mcp.md
---

# Memory inlets realignment

Operational tuning, not a feature cycle. Triggered by an observation: the `/memories` view was showing **two kinds** of memory — concise, confidence-scored, session-linked ones (good) and a couple of long, unreviewed, provenance-less ones added via `save_memory` during this session's work.

## Diagnosis — memory has two inlets
1. **Enrichment loop** (`enrich-memories` cron → `server/services/memory-enrich.ts`) — the preferred path. The LLM distills a session transcript into **concise, durable, confidence-scored** facts with `sessionId` + evidence (provenance); auto-reviewed when `confidence ≥ memoryAutoReviewThreshold` (~0.75).
2. **Direct `save_memory`** (MCP tool / `POST /api/memories` → `createMemory`) — saves raw content. Before this change it had **no `confidence` param** (so `shouldAutoReview(null)` = false → always needs manual review) and **no `sessionId`** (no provenance). Writing long, documentation-style content into it produced the low-signal entries.

Both inlets share `createMemory`'s dedup (`dedupDecision` + `buildDedupCandidates`).

## What changed
- **`save_memory` MCP tool** (`server/lib/agent/tools.ts`, commit `f3f8ac8`, deployed to prod): added an optional **`confidence` (0–1)** param (≥0.75 auto-reviews, matching enrichment) and reworded the tool description to nudge toward **one concise durable sentence** ("architecture detail belongs in handovers/wiki, not memory"). The MCP schema picks this up automatically (built from `agentTools`).
- **Global `~/.claude/CLAUDE.md`** rule softened: "ALWAYS store memories as key decisions are made" → name both inlets, make **enrichment the preferred path** for session-derived knowledge, and reserve `save_memory` for *concise, one-sentence, cross-session* facts enrichment can't see, passing a `confidence`.
- **Cleanup:** archived (reversible) the two bloated prod memories this session created (`7345fe66` doc-assoc 1003 chars, `aeccaa35` merge 1400 chars) — the detail lives in the cycle-26/27 handovers + `wiki/projects.md`, and the enrichment cron will distill concise versions from this session's transcript.
- Wiki updated: `memory.md` (the two-inlet section), `mcp.md` (the `confidence` param + the previously-missing `quick_capture` tool → 11 tools).

## Watch-outs / guidance for future sessions
- **Prefer enrichment** for session knowledge — don't hand-dump architecture/design notes into `save_memory`; those belong in handovers + the wiki. Use `save_memory` sparingly for concise cross-session facts (e.g. a stated user preference) and pass a `confidence`.
- The MCP server points at **prod** — `save_memory` / `create_task` calls land in the prod DB, not dev.
