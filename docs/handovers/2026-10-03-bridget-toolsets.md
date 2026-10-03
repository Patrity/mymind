---
title: Bridget toolsets — ~26 core tool schemas always visible, the rest loaded on demand and persisted per conversation (cycle 78)
cycle: 78
date: 2026-10-03
status: built  # updated to deployed after CD
branch: feat/bridget-toolsets (worktree .claude/worktrees/feat+bridget-toolsets, base 18d015c)
merged: false
deployed: false
specs:
  - ../superpowers/specs/2026-10-03-bridget-toolsets-design.md
plans:
  - ../superpowers/plans/2026-10-03-bridget-toolsets.md
wiki:
  - ../wiki/agent.md
  - ../wiki/agent-jobs.md
  - ../wiki/agent-runtime.md
migrations:
  - 0066 conversations gains active_toolsets text[] not null default '{}' (additive)
migrations_run_on_prod: false
next: cycle 79 — connections + Google mail/calendar (better-auth linkSocial, multi-account)
---

# Bridget toolsets (cycle 78)

Cycle 1 of the connectors programme (78 toolsets → 79 Google → 80 proactive → 81 GitHub + MCP client).
Bridget was sent all ~53 tool schemas on every step; connectors would have pushed that past 80 on a
small local model. Now every tool belongs to a toolset; core sets are always visible, on-demand
sets are listed in a `TOOLSETS` prompt block and become visible once loaded. No tool's behaviour,
schema, approval or headless classification changed.

## What shipped
- `server/lib/agent/toolsets.ts` — registry (`TOOLSETS`, `ON_DEMAND_TOOLSETS`, `parseToolsetIds`, `activeToolNames`, `directoryText`); required `AgentTool.toolset`.
- `load_toolsets` tool (`tools/load-toolsets.ts`) in `bridgetProfile` only (never on `/api/mcp`); headless class `run`.
- `runAgent` `ctx.toolsets = { initial, onChange }` → `prepareStep` returns `activeTools`; auto-load on a call to a hidden tool (execute hook) and on an invalid one (prepareStep scan of the last step); forced-final marker path keeps `activeTools`.
- Prompt: `TOOLSETS` directory after the SHELL block; the lack-a-tool rule, IMAGES rule and capabilities line point at toolsets (final-review fix).
- Runner: seeds from `conversations.active_toolsets` + job `toolsets:`; persists with an order-independent SQL set union; job-declared sets never persisted onto main; failures log `toolsets:persist`.
- Jobs: `toolsets:` frontmatter key (on-demand ids only; parse error lists allowed ids) → wake → `RunInput.toolsets`.
- `/clear` resets `active_toolsets`.

## Deviations from the spec (all ruled during plan/SDD)
1. Job toolsets are frontmatter, not an `agent_jobs.toolsets` column (every other job setting is frontmatter); hence no `/jobs` editor multi-select.
2. Migration 0066 (0064/0065 already existed).
3. `/clear` resets loaded toolsets (spec silent).
4. Invalid calls to hidden tools also auto-load (otherwise the model never sees the schema to fix its args).
5. Main thread: job-declared sets are loaded for that run but not persisted.

## Evidence
- Schema size per step: **53 tools / 39,506 chars (~9.9k tokens) → 26 tools / 18,712 chars (~4.7k tokens), −53%.**
- Gates on the branch: typecheck 0; `pnpm test` 3127 passed / 1 skipped; `pnpm test:db` 872 passed (after the final-review fix wave).
- Mutation checks: prepareStep scan, execute-hook auto-load (maxSteps:1 case), `/clear` reset, union-vs-overwrite, main-thread job persistence — each went red when broken.
- Live (dev, port 3011, real model): new thread "What did I work on in Claude Code in the last two days?" → `load_toolsets(history)` → `search_sessions`/`search_messages`; `active_toolsets = ['history']`; run done.
- Live images pair (dev): new thread "Generate an image of a lighthouse at dusk" → `load_toolsets(images)` → `generate_image`; follow-up "make it night" → `edit_image` directly, **no second load**; `active_toolsets = ['images']`. Generation itself failed on dev (`image generation not configured` — dev has no ComfyUI URL); render is checked on prod after deploy.
- Live core-only regression (dev): new thread "what are my open tasks…" → only `search_tasks`, `active_toolsets = []`, answer rendered (screenshot checked).

## Known limits / follow-ups
- Main accumulates sets Bridget loads herself until `/clear` (savings shrink there first). Consider an idle-unload later if measurement shows it.
- A `/clear` racing a still-running turn can be re-populated by that turn's late union write.
- Rollback below cycle 78 makes any job using `toolsets:` fail to parse (remove the key first).
- `self-improvement-digest` seed calls `list_improvements` (on demand) — auto-loads on first use.
- The dev reasoning head (rig :8004) was down during validation (existing task); dev failed over.
- Deferred minors (SDD ledger): stored order alphabetical vs load order; `ctx.toolsets` type repeated inline in 3–4 places; the maxSteps:1 test duplicates the `run()` helper; forced-final no-marker follow-up still sends all schemas with `toolChoice: 'none'`.
