---
title: Agent self-model hardening — Phase 1 (cycle 49)
cycle: 49
date: 2026-07-23
status: BUILT + reviewed, gates green (typecheck 0 / test 826 / build clean). Final whole-branch review (opus) = Ready to merge (0 Critical / 0 Important). NOT merged/pushed/deployed. AWAITING Tony's merge+deploy decision, then the prod E2E (re-run the exact failing task). Phase 2 (Agent Skills subsystem) gets its own plan next.
branch: feat/agent-skills-self-model (built subagent-driven, 5 plan tasks + 1 final-review cleanup; per-task reports + ledger in .superpowers/sdd/)
docs:
  - ../wiki/agent.md (living reference — cycle-49 notes added: honesty invariant, environment self-model, tool-call-as-text recovery, edit_project aliases/newSlug; updated 2026-07-23)
  - ../superpowers/specs/2026-07-23-agent-skills-self-model-design.md (spec — full four-part design incl. the Phase-2 skills subsystem; mirrored to MyMind doc "Cycle 49 spec")
  - ../superpowers/plans/2026-07-23-agent-self-model-hardening-phase1.md (this plan — Phase 1 only)
  - ../superpowers/plans/00-roadmap.md (cycle-49 row added by this handover)
related:
  - ../handovers/2026-07-01-agent-loop-audit.md (the prior agent-loop reliability work; the forced-final guard 4d485c0 this builds on)
  - ../handovers/2026-06-20-credentialed-native-exec-b3-2.md (the native-root exec the agent uses to reach its own DB)
problem: >
  A real prod /agent conversation (054f2560, 2026-07-23) exposed four compounding failures:
  the agent (1) fabricated "Done" TWICE with zero tool calls — because edit_project could not
  edit aliases or rename a slug, so instead of admitting the gap it hallucinated success;
  (2) had no truthful self-model, so when forced to the DB it assumed sqlite, tried the
  build-baked `@db` host, and burned ~14 exec calls rediscovering topology documented in its
  own repo; (3) stopped mid-turn on a `<tool_call>` block streamed as TEXT — the local Qwen +
  vLLM streaming hermes parser (vllm#31871) returns the tool-call XML as content, which the
  existing forced-final guard (4d485c0) never catches because text WAS emitted; (4) asserted a
  slug rename was "safe (FKs on id)" from partial schema knowledge, missing the denormalized
  `project` slug columns on documents/memories/sessions/tasks.
---

# Agent self-model hardening — Phase 1 (cycle 49)

## What shipped (branch `feat/agent-skills-self-model`, `4d485c0..09999e2`)

Three bleed-stops for the `/agent` loop. Governing principle (mirrors `CLAUDE.md`'s own
rules/skills split): **system prompt = rules, short + behavioral; detail → skills (Phase 2).**

1. **Honesty invariant** (`server/lib/agent/prompt.ts`, `c8cc57b`). The prompt now forbids
   reporting any mutation (create/edit/delete/move/rename/fix) as done without a tool result
   THIS turn, and forbids asserting unverified facts about data (schemas, references, "it's
   safe"). Generalizes the prior image-only rule.
2. **Environment self-model** (`prompt.ts`, `b1cff4c`). The prompt tells the agent it runs as
   native systemd `mymind` (root) in Proxmox LXC 114 — a harness Tony built — that its DB is the
   Docker container `mymind-db` (`docker exec mymind-db psql -U mymind -d mymind`), NOT sqlite
   and NOT host `db`, and that its own source/docs at `/opt/mymind` are readable via `exec` to
   understand or improve itself.
3. **Tool-call-as-text recovery** (`server/lib/agent/run.ts`, `6952b72` + cleanup `09999e2`).
   After the stream drains, if the model emitted a `<tool_call>`/`<function=` marker as text with
   **no** real tool-call (`sawTextToolCallMarker = !sawToolCall && /<tool_call>|<function\s*=/`),
   `runAgent` re-runs once **with tools allowed** (not `toolChoice:'none'`) + a corrective nudge,
   so the call executes through the normal structured/approval path. Distinct event
   `reasoning:agent-recovered-textcall` vs the no-text `reasoning:agent-forced-final` path (which
   is preserved unchanged). The two paths are mutually exclusive by construction.
4. **`edit_project` aliases + rename** (`server/lib/agent/tools.ts`, `388cad5`). The tool now
   accepts `aliases?: string[]` and `newSlug?: string`. The transactional slug-rename cascade
   (across `sessions`/`tasks`/`memories`/`documents.project` + the `documents.path` regexp)
   **already existed** in `updateProject` (`server/services/projects.ts:108-154`) — this was a
   tool-surface + undo change only. Undo correctly targets the post-rename slug and renames back.

Wiki updated in the same change (`23b94f5`). Spec/plan committed (`5ce15e0`/`9ddd8c3`).

## Verification

- Gates: **typecheck 0 · test 826 passed (124 files) · build clean.**
- Per-task: each of the 5 tasks passed an independent spec+quality review (sonnet); reports in
  `.superpowers/sdd/task-{1..5}-report.md`, progress ledger at `.superpowers/sdd/progress.md`.
- Final whole-branch review (opus, `4d485c0..23b94f5`): **Ready to merge = YES**, 0 Critical /
  0 Important. Wiring confirmed live (recovery on the `runAgent` path; widened `edit_project`
  registered via `agentTools → bridgetProfile.tools`); all 4 recovery control-flow invariants and
  the rename-undo target verified by inspection.
- **NOT yet browser/prod-verified** — the schema-level tool test does not exercise the rename
  cascade at runtime (per house pattern); the prod E2E below is the runtime proof.

## Schema note (verified on prod, informs Fix D)

Project refs are **dual**: FKs (`sessions`/`memories`/`documents`) point at `projects.id` (UUID),
but a denormalized `project` (slug text) column lives on `documents`/`memories`/`sessions` and is
the **only** project ref on `tasks` (no `project_id`). Editing `aliases` is safe (unreferenced);
a slug rename must cascade those four columns — which `updateProject` does transactionally.

## Deferred follow-ups

1. **Recovery is single-step (top Phase-2 item).** The recovery follow-up `streamText` has no
   `stopWhen`, so if the model emits a **real** tool call on recovery, the tool runs (dead-end
   fixed) but no wrap-up sentence follows that turn (recorded `warn`; the tool result is in
   history for the next turn). Fix: `stopWhen: stepCountIs(2)` on the marker path + a 2-step mock
   test so the model can call the tool *and* summarize. Filed as MyMind task.
2. **Marker-strip from persisted text** (deferred from the spec): the recovery re-run is the
   shipped behaviour; stripping the stray `<tool_call>` from the stored assistant message is a
   cosmetic follow-up (needs touching the ws.ts/orchestrator finalization site).
3. **Serving-stack root cause** (Ops, on the LAN): bump the Qwen rig's vLLM past #31871 and
   confirm `--enable-auto-tool-choice --tool-call-parser hermes`. The harness guard ships
   regardless. See the plan's "Ops" section for how to locate the endpoint (ai_config `reasoning`).

## Next steps (Tony)

1. Decide merge/deploy: deploy = push `master` → CD (native LXC 114). Per convention this cycle is
   held unmerged awaiting your call.
2. **Prod E2E after deploy** (browser-testing + prod-deploy skills): re-run the exact failing task
   on `/agent` — *"clean up the neo4nls project: remove the `neo4nls-2` alias and rename the slug
   `neo4nls-3` → `neo4nls`."* Assert: (a) `edit_project` actually called (undo token in the
   activity log), (b) no "Done" without a tool result, (c) the rename cascades
   (`select project, count(*) from tasks where project like 'neo4nls%' group by 1` shows the new
   slug), (d) no mid-turn stop.
3. **Phase 2 — Agent Skills subsystem** (spec §2): its own brainstorm-is-done → writing-plans →
   build cycle. Document-backed skills, 3-tier progressive disclosure, `use_skill`, autonomous
   self-authoring (undo + audit + validation gate + `agentSkillsEnabled` kill-switch), a
   `/settings/skills` page reusing the document editor, and migrating the prompt's web/exec detail
   into seed skills (which shrinks the base prompt).
