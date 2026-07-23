---
title: Agent Skills + self-model hardening
date: 2026-07-23
status: draft
supersedes: []
related:
  - server/lib/agent/prompt.ts
  - server/lib/agent/run.ts
  - server/lib/agent/tools.ts
  - server/services/projects.ts
  - server/services/conversations.ts
  - server/db/schema/conversations.ts
  - docs/wiki/agent.md
  - docs/handovers/2026-07-01-agent-loop-audit.md
  - docs/superpowers/specs/2026-06-16-project-association-foundation-design.md
---

# Agent Skills + self-model hardening (Cycle 49)

## Problem

The MyMind agent (`/agent`, voice + text) carries **all** of its detailed guidance in a single
always-on system prompt (`server/lib/agent/prompt.ts`) and has **no truthful model of its own
runtime**. A single real conversation on prod (2026-07-23) exposed four independent failures that
compound each other: it **fabricated completed work**, **could not do what it claimed** (tool gap),
**did not know its own environment**, and finally **stopped mid-turn with no error**.

This cycle does three things: (1) move *detail* out of the always-on prompt into
**progressively-disclosed, agent-editable skills**; (2) harden the always-on prompt into a short
**behavioral rules** layer (honesty invariant + a truthful self-model); (3) fix the two reliability
bugs that made the conversation fail silently.

Governing principle — the same one `CLAUDE.md` already states for Claude Code in this repo:
**prompt = rules (always-on, short, behavioral); skills = how-to (on-demand, detailed).**

### Evidence (prod, conversation `054f2560`, 2026-07-23)

Pulled from `conversation_messages` (SSH to the Proxmox host was down; read via the authenticated
public API with the `mm_` bearer). Turn by turn:

1. User: clean up the `neo4nls` project's stale `*-2` aliases.
2. Agent: **"Done. Slug `neo4nls-3` → `neo4nls`, aliases cleaned"** — **with zero tool calls.**
   Pure fabrication.
3. User: "do we have others?" → confident 10-row table, **no tool calls**.
4. User: "do it" → **"Done. All 10 projects cleaned."** — **again zero tool calls.** Second fabrication.
5. User: "wait are you hallucinating? I still see slug `neo4nls-3`" — caught.
6. Agent finally acts, and spends **~14 `exec` calls** rediscovering its own topology: assumed
   **sqlite** (`sqlite3` → exit 127), `find`-spelunked for a `.db`, tried `psql -h db` (the
   build-baked `@db` hostname → exit 2, the exact `DEPLOYMENT.md` gotcha), `apt-get install`ed
   postgres-client, and eventually stumbled onto `docker exec mymind-db psql`.
7. The final message **just stops** — its raw content ends with a literal
   `<tool_call><function=exec>…</tool_call>` block streamed **as text**.

Root causes, each mapped to a fix below:

- **A — Fabrication.** `edit_project`'s schema is `{ slug, name?, description?, active? }` — no
  `aliases`, no slug rename. The agent **could not** do the task through its tools, so instead of
  saying so it hallucinated success. The prompt forbids narrating a *search* without a tool
  (`prompt.ts:56`) and faking an *image* (`prompt.ts:58`) but has **no general rule** against
  claiming a mutation succeeded without a tool result. It also asserted the rename was "safe
  because FKs are on `id`" from **partial** schema knowledge (see D).
- **B — No self-model.** The prompt says "you run as root in your own LXC" (`prompt.ts:60`) but
  nothing about Postgres-in-Docker (`mymind-db`), that it is **not** sqlite, the `@db` trap, or that
  **its own source and docs live at `/opt/mymind`** and it may read them.
- **C — Mid-turn stop.** A **distinct** failure from the one fixed in `4d485c0` (which forces a
  final answer when *tools ran but no text was emitted*). Here **text was emitted** (a tool call
  *as* text), so `sawText === true` and that guard never fires. Confirmed upstream cause:
  vLLM streaming + hermes tool-parser returns the Hermes `<tool_call>` XML as raw text
  ([vllm-project/vllm#31871](https://github.com/vllm-project/vllm/issues/31871)). The primary is a
  local Qwen (reasoning chain = `[qwen local, Claude-via-LiteLLM failover]`).
- **D — Tool gap + schema reality.** Verified against prod: FKs (`sessions`, `memories`,
  `documents`) reference `projects.id` (**UUID**), but a **denormalized `project` slug-text column**
  exists on `documents` / `memories` / `sessions` and is the **only** project reference on `tasks`
  (no `project_id` at all). So editing `aliases` is safe; a **slug rename is not** — it strands
  every `*.project` slug pointer. The agent's "safe" claim was half-right and dangerous.

## Goals

1. The agent **never reports an action complete** without a tool result confirming it that turn.
2. The always-on prompt is **short and behavioral**; detail lives in skills. Base-prompt token count
   goes **down** even as capability grows.
3. The agent has a **truthful, compact self-model**: its harness, its DB topology, that its own code
   is at `/opt/mymind` and readable.
4. **Agent Skills subsystem**: progressive disclosure (3-tier), stored as documents, editable in a
   settings page, and **self-authored autonomously** by the agent (undo + audit + kill-switch).
5. A turn **never silently ends on an unparsed tool call**; the agent recovers.
6. The agent can do **safe project maintenance** (aliases, slug rename with cascade) through tools,
   not hand-rolled `psql`.

## Non-goals

- Semantic/retrieval-based skill surfacing (embed descriptions, auto-inject top-k). Deferred to a
  phase-2 upgrade on top of the static index; the static Tier-1 index ships first (more reliable for
  a local model).
- On-disk `SKILL.md` filesystem layout with `scripts/`/`references/` dirs. We reuse the document
  store; frontmatter stays *shape-compatible* with the convention for future interop, but skills are
  documents, not files.
- Approval/review gate for agent-authored skills — explicitly **rejected** by Tony in favor of
  autonomous + undo. A cheap *validation* gate (not an *approval* gate) remains.
- Structural tool-call history (feed prior tool calls/results back as tool messages) — that is the
  separate high-priority task `5cc52941` (cycle 43). It **reinforces** goal 1 (the model imitates
  past "Done"-without-tools turns) and should be sequenced near this work, but is out of scope here.

## Design

### 1. System-prompt hardening — the always-on "rules" layer (`prompt.ts`)

`composePrompt` gains three things and *sheds* detail:

- **Honesty invariant (A).** Generalize the image-only rule to all mutations. Wording (exact
  phrasing set at implementation; intent frozen here):
  > You have NOT created, edited, deleted, moved, or fixed anything unless a tool call THIS turn
  > returned a success result. Never report an action as done ("Done", "I removed X", "I renamed Y")
  > without that result. If you lack the tool or capability to do it, say so plainly and stop — a
  > fabricated success is the worst possible answer. Do not assert facts about data you have not
  > verified with a tool this turn (schemas, what references what, "nothing depends on this", "it's
  > safe").
- **Environment core (B-core), ≤ ~6 lines.** A compact, truthful self-model:
  > You are the MyMind agent, running as the native `systemd` service `mymind` (as root) inside
  > Proxmox LXC 114 — a custom harness Tony built and maintains. Your Postgres is the Docker
  > container `mymind-db`; reach it with `docker exec mymind-db psql -U mymind -d mymind` (it is
  > **not** sqlite, and the host `db` only resolves at build time — do not use it). Your own source
  > code and docs live at `/opt/mymind` (app) and `/opt/mymind/docs` (wiki, DEPLOYMENT.md,
  > handovers) — you may read them with `exec` to understand or improve yourself. For anything
  > beyond these basics, load the relevant skill before acting.
- **Skills index (Tier-1)** — see §2; injected here at build time with the imperative: *"When a task
  matches a skill, you MUST `use_skill` to load it before acting."*
- **Shed detail.** Migrate the long web-research bullets (eBay/403/diminishing-returns,
  `prompt.ts:51–54`) and the deep `exec` guidance (`prompt.ts:60–65`) **into seed skills**
  (`web-research-etiquette`, `environment-and-topology`). The base prompt keeps only the one-line
  pointers. Net base-prompt size decreases.

`buildSystemPrompt` already composes per-turn and is DB-injectable (`deps.buildSystemPrompt`), so
the skills-index query slots in cleanly and tests stay hermetic.

### 2. Agent Skills subsystem

**2a. Storage — skills as documents.** A skill is a **document** with reserved frontmatter:

```yaml
kind: skill
name: db-maintenance          # unique, kebab-case; the use_skill key
description: ...              # Tier-1: what it is
whenToUse: ...               # Tier-1: the trigger ("Use when …")
active: true                 # in the Tier-1 index + loadable
source: agent | human        # provenance for the settings UI
```

Filed under a reserved `skills/` section of the `mymind` project. This reuses, for free: the
document editor components (the settings-page requirement), embeddings, live-reactivity, undo, and
the agent's own `read_document` / `grep_document` / `edit_section` / `save_document` tools.
`kind: skill` documents are **excluded from normal `search_docs`/`search_passages`** results (so
they don't pollute knowledge search) — they are reached only via the Tier-1 index + `use_skill`.

*Alternative considered — a dedicated `agent_skills` table.* Rejected: it duplicates the editor,
search, live, and undo machinery and fights the explicit intent to reuse the document-page
components.

**2b. Three-tier progressive disclosure.**

- **Tier 1 — Discovery.** `buildSystemPrompt` queries active skills and injects
  `name + description + whenToUse` (~100 tokens each) into the prompt.
- **Tier 2 — Activation.** New **`use_skill(name)`** tool (kind: `read`) returns the full body of
  the named active skill (thin wrapper over the skill document's content). Unknown/inactive name →
  a clear "no such active skill" result, not an error.
- **Tier 3 — Execution.** The body may reference other documents or commands the agent pulls on
  demand via existing tools / `exec`.

**2c. Self-authoring — autonomous + undo (locked decision).** New tools `create_skill`,
`edit_skill`, `delete_skill` (kind: `destructive`; thin contracts over the document tools). A
new/edited skill is **active immediately** — no approval step. Safety layers that do **not** block
autonomy:

- **Undo token** on every write (existing pattern) + an `activity_log` span (existing audit).
- **Validation gate** (autonomous ≠ unvalidated): required frontmatter present
  (`name`, `description`, `whenToUse`), `name` unique + kebab-case, body non-empty and under the
  convention cap (~5k tokens); a failed validation rejects the write with a specific reason (the
  agent then fixes and retries — this is a tool result, not a silent drop).
- **Global kill-switch** setting `agentSkillsEnabled` (default **on**): when off, the Tier-1 index is
  omitted from the prompt and `use_skill`/authoring tools are withheld. This is Tony's "disable-all".

**2d. Settings page `/settings/skills`.** Reuses the document-page components: a list (name,
description, `active` toggle, `source` badge, updated-at), row → the existing document editor,
per-row undo, and the kill-switch toggle. Follows the cycle-42 settings-subpages pattern.

**2e. Seed skills (hand-written; the agent maintains them thereafter).**
`environment-and-topology` (the full deploy/DB/topology detail migrated out of the prompt),
`db-maintenance` (safe prod-Postgres inspection/mutation, **including the slug-cascade lesson**),
`self-improvement` (how to audit/author/curate skills), `deploy-and-migrate`, `incident-triage`,
`web-research-etiquette` (the migrated web bullets).

### 3. Fix C — tool-call-as-text recovery (`run.ts` + serving stack)

Two layers (defense in depth):

- **Serving stack (root cause).** On the Qwen rig, confirm/patch vLLM past #31871 and ensure
  `--enable-auto-tool-choice --tool-call-parser hermes`. Verified on the LAN at implementation time
  (an infra step in the plan, not a code change here).
- **Harness guard (`run.ts`).** After the stream drains, detect a dangling unparsed tool-call marker
  in the emitted text (`<tool_call>` or `<function=`). Extend the existing forced-final condition
  (currently `!sawText && sawToolCall`) to also fire on `sawTextToolCallMarker`. On that path, re-run
  **once** with a corrective nudge ("You emitted a tool call as plain text; issue it as a real tool
  call") so the recovered intent goes through the **normal structured + approval** path, and **strip**
  the stray marker from the persisted assistant text (the `applyImageEmbeds` `[image]`-strip
  precedent). **Do not parse-and-execute the raw blob** — that would bypass the approval gate and
  trust a malformed string.

### 4. Fix D — project maintenance (`tools.ts` + `server/services/projects.ts`)

- **D1 — aliases (easy, safe).** `edit_project` gains `aliases?: string[]`; `updateProject` writes
  the `aliases` array. Nothing references aliases, confirmed by the agent's own zero-hit search and
  the schema probe.
- **D2 — `rename_project(fromSlug, toSlug)` (careful).** New service + tool that, in **one
  transaction**: verifies `toSlug` is free, updates `projects.slug`, and **cascades the denormalized
  slug columns** `documents.project`, `memories.project`, `sessions.project`, `tasks.project` to the
  new slug. Returns an undo that reverses all of it. `publishChange` for `project` (+ any affected
  resource lists). This is the safe, transactional version of what the agent hand-rolled.

## Locked decisions

1. Skills mechanism = **document-backed + static Tier-1 index + `use_skill` load tool** (not a
   dedicated table; not semantic retrieval in v1; not on-disk SKILL.md).
2. Self-authoring = **autonomous + undo + audit + validation gate + kill-switch** (no approval gate).
3. Prompt = **rules only** (honesty + environment-core + skills-index); all detail → skills.
4. Fix C recovery = **detect-and-re-run through the normal tool path**, never execute the raw blob.
5. Fix D = **aliases now (D1)**, **slug rename with transactional cascade (D2)**.
6. Ship in **two implementation phases** (see Rollout); one spec.

## Edge cases

- **Skill name collision** on create → validation rejects with the conflicting name.
- **Skill body > cap** → rejected; the agent must split or trim (a skill that needs >5k tokens is a
  smell — it should reference Tier-3 docs).
- **Kill-switch off mid-conversation** → next `buildSystemPrompt` omits the index; an in-flight
  `use_skill` returns "skills disabled".
- **A skill instructs the agent to do harm / loops** → mitigated by the validation gate (structure,
  not semantics) + undo + audit; semantic safety is accepted risk under autonomous mode (parallels
  the accepted exec exfil-risk).
- **`rename_project` target already exists** → transaction aborts, tool returns a clear conflict.
- **`rename_project` partial cascade** → the whole thing is one transaction; either all slug columns
  move or none do.
- **Marker false positive** (a skill body or user text legitimately contains `<tool_call>`) → the C
  guard only inspects the **model's emitted assistant text** for a *trailing/unclosed* marker, and
  the re-run is idempotent (produces a normal answer), so a false positive costs one extra model call,
  never a wrong execution.

## Testing

- **Prompt (unit):** honesty invariant + environment-core lines present; Tier-1 index renders active
  skills and omits inactive/when-disabled; base-prompt token count decreased vs. baseline.
- **Skills (unit + integration):** `use_skill` returns body for active, refuses inactive/unknown;
  create/edit/delete round-trip with undo; validation gate rejects (bad name, empty body, oversize,
  missing frontmatter); `kind:skill` excluded from `search_docs`.
- **Fix C (unit, extends `test/run-agent.test.ts`):** a stream that emits a `<tool_call>` marker as
  text and no real tool-call triggers exactly one corrective re-run with the nudge; a clean run does
  not; the stray marker is stripped from persisted text.
- **Fix D (unit + integration):** `edit_project` writes aliases + undo restores; `rename_project`
  cascades all four `*.project` columns in one transaction, undo reverses, target-exists conflicts.
- **E2E (browser-testing skill, on prod after deploy):** re-run the **exact failing task** — "clean
  up the neo4nls slug and aliases" — and confirm it (a) uses tools, (b) never claims unverified
  completion, (c) loads `db-maintenance`, (d) completes the rename+cascade, (e) does not stop mid-turn.

## Rollout

Behind the `agentSkillsEnabled` kill-switch (default on). **Two phases, one spec:**

- **Phase 1 — bleed-stops (small, independent):** §1 prompt hardening (honesty + environment-core),
  §3 fix C, §4 fix D. Ships fast; stops the fabrication + the mid-turn stop + the tool gap.
- **Phase 2 — skills subsystem (cycle-sized):** §2 (data model, Tier-1 index, `use_skill`,
  self-authoring tools, settings page, seed skills), and the migration of prompt detail into seed
  skills.

Standard cycle close: `wiki/agent-skills.md` (new) + `wiki/agent.md` update (prompt slimming +
honesty invariant + C guard), handover, roadmap cycle-49 row, MyMind mirror.

## Open questions

1. **Skill `name` uniqueness scope** — global, or per-project? v1: global within the reserved
   `mymind/skills` section (the agent is single-tenant). Revisit if per-profile skills appear.
2. **Should subagents (`research_web`/`search_brain`) see skills?** v1: no — skills target the main
   loop; subagents get a task + context. Revisit if a subagent needs a how-to.
3. **Serving-stack fix availability** — is the rig's vLLM already past #31871, or does it need a
   bump? Resolved at implementation time on the LAN; the harness guard ships regardless.
4. **Interop with Claude Code skills** — frontmatter is kept shape-compatible, but a shared
   source-of-truth (agent reads the repo's `.claude/skills`) is deferred.
