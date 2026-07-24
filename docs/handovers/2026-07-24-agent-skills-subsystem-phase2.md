---
title: Agent Skills subsystem — Phase 2 (cycle 49)
cycle: 49
date: 2026-07-24
status: BUILT + fully reviewed, gates green (typecheck 0 / test 850 / build clean). Final whole-branch review (opus) = Ready to merge after its fix wave, which was applied (6e4d792). NOT merged/pushed/deployed. ⚠️ The AGENT-SIDE E2E WAS NEVER RUN — the reasoning rig (192.168.2.25) is unreachable from the dev machine, so nothing has proven at runtime that the model actually calls `use_skill`. ⚠️ Deploying REQUIRES the post-deploy seed step (see "Deploy requirement") or prod loses web-research guidance.
branch: feat/agent-skills-subsystem (built subagent-driven, 9 tasks + 1 final fix wave; per-task reports + ledger in .superpowers/sdd/)
docs:
  - ../wiki/agent-skills.md (NEW — living reference for the whole subsystem)
  - ../wiki/agent.md (skills note + updated 2026-07-24)
  - ../superpowers/specs/2026-07-23-agent-skills-self-model-design.md (spec §2 is what this builds)
  - ../superpowers/plans/2026-07-24-agent-skills-subsystem-phase2.md (this plan)
  - ../DEPLOYMENT.md (new post-deploy seed step)
related:
  - ../handovers/2026-07-23-agent-self-model-hardening-phase1.md (Phase 1 — honesty invariant, env self-model, tool-call-as-text recovery, edit_project rename)
problem: >
  Phase 1 gave the agent a truthful self-model but did it by ADDING to an already-bulky
  always-on system prompt. Detail that only matters occasionally (deploy steps, DB topology,
  web-research etiquette) was charged to every turn — which matters more here than for a
  big-context model, because the agent's primary is a local Qwen that degrades as context
  bloats. Phase 2 introduces progressive disclosure: a cheap index in the prompt, full
  procedures loaded on demand, and the agent able to write its own.
---

# Agent Skills subsystem — Phase 2 (cycle 49)

## What shipped (branch `feat/agent-skills-subsystem`, `36628a9..HEAD`)

**A skill IS a document** — `documents.type='skill'`, reserved path `/projects/mymind/skills/<name>.md`,
contract in the existing `frontmatter jsonb`. **No database migration was needed**; skills inherit the
document editor, embeddings, live-updates, undo and audit for free.

- **Service** (`server/services/skills.ts`) — the only module that knows the mapping. Structural
  validation (kebab-case unique name, non-empty description/whenToUse/body, 20,000-char body cap).
- **Kill-switch** (`server/lib/agent/skills-config.ts`) — `settings` key `agent_skills_enabled`,
  default **on**, mirroring `persona.ts`. Off ⇒ index omitted + `use_skill` refuses.
- **Tier-1 index** (`server/lib/agent/prompt.ts`) — `renderSkillsIndex` emits name + description +
  when-to-use per skill. `composePrompt` stays **pure**; `buildSystemPrompt` does the DB load inside a
  try/catch so a skills outage can never break a turn.
- **Four tools** (`server/lib/agent/tools.ts`) — `use_skill` (read), `create_skill`/`edit_skill`
  (**create — ungated on purpose**), `delete_skill` (destructive). All mutations carry undo +
  `publishChange({resource:'document'})`. `source` is forced server-side (`agent`), never model-settable.
- **Search exclusion** (`server/services/documents.ts`) — `notSkill()` in all three `searchDocs`
  lanes + `searchPassages`. The `isNull(type)` branch is essential: `type` is NULL for ordinary
  documents and `ne(NULL,'skill')` is NULL, so a naive `ne()` would have hidden **every** document.
- **REST** (`server/api/skills/*`, `server/api/settings/skills-enabled.*`) — live-verified for
  happy path, 400 on duplicate/malformed, 404 on missing.
- **UI** (`/settings/skills` + `SkillsTab.vue` + nav entry in `app/layouts/default.vue`).
- **Six seed skills** (`scripts/seed-skills.ts`, idempotent): `environment-and-topology`,
  `db-maintenance`, `self-improvement`, `deploy-and-migrate`, `incident-triage`,
  `web-research-etiquette`.

## Autonomy (Tony's explicit decision)

Agent-authored skills go live **immediately** — there is no approval or review gate. Safety is
structural validation + undo + activity-log audit + the kill-switch. Consequence worth knowing: the
skill tools are non-`dangerous`, so they are also exposed over the **MCP surface** — a Claude Code
session can author or delete MyMind agent skills, same as it can already delete documents.

## The context-economy result — stated honestly

Measured, not estimated:
- Base prompt (no skills indexed): **6187 → 5324 chars** (the four web-research bullets moved into
  the `web-research-etiquette` skill).
- Assembled prompt with the six seed skills indexed: **7361 chars**.

So the always-on prompt is currently **larger** than before this cycle. The win is the ratio, not the
absolute: ~2,000 chars of pointers stand in for ~40,000 chars of procedure that stays on disk until
`use_skill` fetches the one that's needed, and a seventh skill costs ~100 tokens rather than its whole
body. Every *active* skill is charged to every turn — keep `description`/`whenToUse` terse and retire
unused skills with `active:false`.

## Verification — what is and isn't proven

**Proven:** gates (typecheck 0 / **test 850** / build clean); service CRUD against the real dev DB
(implementer probe + an independent reviewer probe with a negative control); REST verified live for
all status codes; **UI browser-verified 6/6** (nav, list+badges, active-toggle persists reload,
edit→save, kill-switch persists, 0 console errors); seed script idempotent (6 created → 6 updated);
and a probe confirming `buildSystemPrompt` renders **all six seeds** into a real prompt (7361 chars,
index present).

**NOT proven — the core value claim.** No agent conversation has ever run against this branch. The
reasoning rig (`192.168.2.25`) is unreachable from the dev machine — `/api/agent/chat` returns
`data: [DONE]` with no text and the log shows `ENETUNREACH 192.168.2.25:8004` after 3 attempts;
LiteLLM failover did not rescue it. So it is **unverified** that the local Qwen actually calls
`use_skill` when an index line matches, and that a multi-KB `create_skill` body survives the
vLLM/hermes tool-call path (the same path that had a tool-call-emitted-as-text bug fixed in Phase 1).

That failure mode is worse than neutral: a model that ignores the index is now *less* capable than
before, because the web-research detail is no longer inline — and the kill-switch does **not**
mitigate it (turning skills off omits the index but does not restore the deleted bullets; that needs
a code revert). **Treat the first post-deploy agent conversation as the acceptance test**, and watch
specifically for a `use_skill` call on a web-research question.

## Deploy requirement (do not skip)

Nothing installs the seed skills automatically. After deploying, run on prod (note `.env.native`, not `.env`):

```bash
node_modules/.bin/tsx --env-file=.env.native scripts/seed-skills.ts
```

Now documented in `docs/DEPLOYMENT.md`, with `pnpm seed:skills` (dev form) in `package.json`. Without
this, prod has a prompt pointing at a `web-research-etiquette` skill that does not exist.

## Deferred follow-ups

- `delete_skill` TOCTOU (ignores `deleteSkill()`'s boolean) — negligible single-user.
- `searchPassages` has no try/catch around `embedOne()` (pre-existing; unlike `searchDocs` it has no
  non-vector lane to fall back to, so a real fix means designing a degraded mode).
- `scripts/` sits outside the Nuxt typecheck globs, so `seed-skills.ts` is not type-checked
  (pre-existing, repo-wide, all 6 scripts).
- `Skill`/`SkillInput` live in `server/services/skills.ts`, so `SkillsTab.vue` redeclares the
  interface client-side and can drift silently — move to `shared/types/skills.ts`.
- `listSkills` does `select()` (all columns incl. full bodies) on every turn just to render the index.
- Phase-1 leftover: the tool-call-as-text recovery is single-step (task `00ac1684`).

## Next steps (Tony)

1. Merge + push (CD deploys), **then run the seed step above**.
2. **Acceptance test:** open `/agent` and ask a web-research question. Expect a `use_skill` chip for
   `web-research-etiquette`. Then ask it to record something it learned and expect `create_skill`,
   with the new skill appearing at `/settings/skills` with an `agent` badge. If it does *not* reach
   for skills, that is the prompt-adherence risk above — the lever is the Tier-1 wording in
   `renderSkillsIndex`, not more code.
3. Phase-1's prod E2E (the neo4nls rename) is also still outstanding — see that handover.
