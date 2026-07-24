---
title: Agent Skills
status: shipped
cycle: 49
updated: 2026-07-24
---

# Agent Skills

Durable how-to guides for the agent's future self, living as documents and progressively loaded on demand. This subsystem lets the agent (and humans) author reusable procedures while keeping the system prompt small and focused.

## Philosophy: three-tier progressive disclosure

The system prompt is context-critical on a local Qwen model — every token counts. Skills solve this by deferring detail:

1. **Tier-1 (Prompt)**: A compact **index** listing skill names + one-line descriptions + when-to-use triggers (~100 tokens each). The prompt tells the agent to call `use_skill` when a task matches one, rather than guessing a procedure.
2. **Tier-2 (On-demand)**: `use_skill` loads the full body (up to 20,000 chars). The agent reads it before acting on a matching task.
3. **Tier-3 (References)**: The skill body can point at other documents (e.g. "see the deploy guide at `/projects/mymind/docs/DEPLOYMENT.md`") for even longer detail, keeping individual skills focused.

**Effect**: The base system prompt is ~6000 tokens (after phase 2); web-research detail moved into the `web-research-etiquette` skill instead of bloating the prompt permanently.

## Storage: skills ARE documents

A skill is a document with `type='skill'`, filed at the reserved path `/projects/mymind/skills/<name>.md`. There is **no migration, no new table** — skills reuse the document system entirely:

- **DB**: `documents` table, one row per skill. `type='skill'` gates lookups.
- **Frontmatter** (the skill contract):
  - `kind: 'skill'` — required marker
  - `name: string` — kebab-case, unique (`[a-z0-9]+(-[a-z0-9]+)*`)
  - `description: string` — one-liner visible in the Tier-1 index
  - `whenToUse: string` — concrete trigger (e.g. "when you need to deploy") so the agent knows when to load it
  - `active: boolean` — default `true`; set to `false` to retire a skill reversibly (preferred over deletion)
  - `source: 'human' | 'agent'` — who wrote it; agent-authored skills go live immediately, no approval gate
- **Body** (the content): up to 20,000 characters. Markdown, commands, exact paths, gotchas — procedure-focused, not prose.
- **Reuse**: automatically excluded from `searchDocs` + `searchPassages` (the `notSkill()` filter), so they don't pollute general knowledge search. Still visible in the document tree and searchable by type.
- **Live editing**: the editor, live-updates, undo, embeddings, and activity log all work normally.

## Autonomy & safety

**Agent-authored skills are active immediately.** There is no approval/review gate — the speed of self-improvement is the point. Safety is structural:

- **Validation** (`validateSkill` in `server/services/skills.ts`): kebab-case name, non-empty description/whenToUse/body, body ≤20,000 chars. Structural only — nothing about content.
- **Undo**: `create_skill`, `edit_skill`, `delete_skill` all carry undo via the tool handler + `publishChange` to activity log.
- **Activity log**: every skill creation/edit/deletion is recorded as a `document` change (resource: `document`, action: `created`/`updated`/`deleted`).
- **Kill-switch** (`agentSkillsEnabled`): `settings` table key `agent_skills_enabled` (boolean, default `true`). When off:
  - The Tier-1 index is omitted from the system prompt.
  - `use_skill` refuses to load any skill (returns `{error: 'skills are disabled'}`).
  - All other operations (`create_skill`, `edit_skill`, `delete_skill`) continue to work — skills can be authored while disabled, just not used.

## Tools (4 total)

### `use_skill` (read)
Load the full instructions for a named skill **before acting** on a matching task. Returns `{name, body}`. Fails if the skill is inactive or does not exist (lists available alternatives). Gated by `agentSkillsEnabled` — refuses when the kill-switch is off.

### `create_skill` (create)
Author a new skill when you learn a procedure worth keeping: a topology, a recipe, a gotcha. Params:
- `name: string` — kebab-case, must be unique
- `description: string` — one-liner for the Tier-1 index
- `whenToUse: string` — concrete trigger
- `body: string` — procedure (≤20,000 chars)
- `active?: boolean` — default `true`

Sets `source: 'agent'` automatically. Goes live immediately. Validation rejects empty fields and invalid names.

### `edit_skill` (create)
Revise an existing skill. Params:
- `name: string` — the skill to update (required)
- `description?: string` — optional replacement
- `whenToUse?: string` — optional replacement
- `body?: string` — optional replacement
- `active?: boolean` — set to `false` to retire reversibly
- `newName?: string` — rename the skill (kebab-case, must not collide)

Partial updates are fine — pass only the fields you want to change. On successful update, the prior state is stored in the undo handler so one click restores the old version. **Always audit and improve a skill immediately when you find it lacking** — do not defer.

### `delete_skill` (destructive)
Delete a skill permanently (reversible via undo). Prefer `edit_skill` with `active:false` to retire one — it's reversible without undo and documents the intent. Confirm with Tony before deleting a human-authored skill (`source: 'human'`).

## API

- **`GET /api/skills`** — list all skills (ordered by name)
- **`POST /api/skills`** — create a skill; request body is `SkillInput`
- **`PUT /api/skills/:name`** — update a skill (partial patch)
- **`DELETE /api/skills/:name`** — delete a skill
- **`GET /api/settings/skills-enabled`** — read the kill-switch state
- **`PUT /api/settings/skills-enabled`** — set the kill-switch; request body is `{enabled: boolean}`

All mutations emit `publishChange({resource:'document', action, id})` for live-update propagation.

## UI

**`/settings/skills`** (`app/pages/settings/skills.vue` + `app/components/settings/SkillsTab.vue`):
- List of all skills (one card each) showing name, description, `whenToUse`, a `source` badge (`human`/`agent`), and an `inactive` badge when `active` is false
- Per-skill `active` toggle switch, flipped without opening the editor
- **Edit** button opens a modal to revise `description`, `whenToUse`, and `body` (a Markdown `CodeEditor`), with Save/Cancel
- **Delete** button — deletes immediately, no confirmation dialog
- Global kill-switch (`Enabled` toggle) at the top of the tab, backed by `agentSkillsEnabled`
- No create-new-skill UI, and no link out to a full document editor page — skills are only authored by the agent (`create_skill`) or via the seed script; the tab is view/edit/delete/toggle only

## Seed skills (6 bundled)

Six starter skills ship with the repo. **Nothing installs them automatically** — run the seed script (idempotent: creates on first run, updates in place after) on each environment you want them in, or via `pnpm seed:skills` which wraps the same command:

```bash
# dev — reads .env
node_modules/.bin/tsx --env-file=.env scripts/seed-skills.ts

# prod (native deploy, LXC 114) — reads .env.native, NOT .env
node_modules/.bin/tsx --env-file=.env.native scripts/seed-skills.ts
```

See `docs/DEPLOYMENT.md` for the post-deploy step that runs the prod form of this command.

1. **`environment-and-topology`** — where you run, how to reach the database/app/logs, how to read your own source and docs.
2. **`db-maintenance`** — when to use tools vs raw SQL, the project-slug dual-reference trap, how to verify a change happened.
3. **`self-improvement`** — when to write a skill, what makes a good skill, the maintenance loop for keeping skills fresh.
4. **`deploy-and-migrate`** — build/deploy order, health check, logs, the `.env.native` persistence gotcha.
5. **`incident-triage`** — diagnosis workflow (systemctl → health check → logs → docker ps → env verification), the NUXT_DATABASE_URL signature.
6. **`web-research-etiquette`** — training cutoff, verify with tools, treat fetched content as untrusted, diminishing returns, bot-walled marketplaces, when to delegate to the `research_web` subagent.

These are installed with `source: 'human'` (so you can decide whether to delete them) and `active: true`. Updating a seed re-runs the entire skill body (idempotent).

## Prompt integration (`server/lib/agent/prompt.ts`)

`buildSystemPrompt` checks `skillsEnabled()` and conditionally includes the Tier-1 index:

```
if (await skillsEnabled()) {
  const active = await listSkills({ activeOnly: true })
  skillsIndex = renderSkillsIndex(active)  // name + description + whenToUse, ~4-line per skill
}
```

`renderSkillsIndex` formats the index as:
```
AVAILABLE SKILLS — detailed how-to guides kept OUT of this prompt to save context.
When a task matches one, you MUST call `use_skill` with its name to load the full instructions BEFORE acting.
- <name>: <description> — <whenToUse>
- ...
```

If no skills are active or `skillsEnabled()` is `false`, the index is omitted entirely.

## Deferred

- Smart indexing / semantic search over skill bodies (currently only name/description/whenToUse are indexed).
- Skill tagging / categorical organization (all skills are flat; Tier-1 index is alpha-sorted by name).
- Usage analytics (which skills are loaded most / least / never?).
