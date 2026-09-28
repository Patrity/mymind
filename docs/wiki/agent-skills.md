---
title: Agent Skills
status: built
cycle: 74
updated: 2026-09-28
---

# Agent Skills

Durable how-to guides for the agent's future self, stored as markdown in `agent_skills` (since cycle 74; before that they were documents) and progressively loaded on demand. This subsystem lets the agent (and humans) author reusable procedures while keeping the system prompt small and focused.

## Philosophy: three-tier progressive disclosure

The system prompt is context-critical on a local Qwen model — every token counts. Skills solve this by deferring detail:

1. **Tier-1 (Prompt)**: A compact **index** listing skill names + one-line descriptions + when-to-use triggers (~100 tokens each). The prompt tells the agent to call `use_skill` when a task matches one, rather than guessing a procedure.
2. **Tier-2 (On-demand)**: `use_skill` loads the full body (up to 20,000 chars). The agent reads it before acting on a matching task.
3. **Tier-3 (References)**: The skill body can point at other documents (e.g. "see the deploy guide at `/projects/mymind/docs/DEPLOYMENT.md`") for even longer detail, keeping individual skills focused.

**Effect (measured, not estimated).** The base prompt — with no skills indexed — went from **6187 → 5324 chars** when the four web-research bullets moved into the `web-research-etiquette` skill. With the six seed skills indexed, the assembled prompt is **7361 chars**: the Tier-1 index costs ~2,000 chars.

So be precise about the win: the always-on prompt is currently *larger* than before this cycle (7361 vs 6187), because six skills are now advertised. The economy is in the ratio — ~2,000 chars of pointers stand in for ~40,000 chars of procedure detail that stays on disk until `use_skill` pulls exactly the one that's needed. Adding a seventh skill costs ~100 tokens, not its whole body. Keep `description`/`whenToUse` short for that reason, and retire unused skills with `active: false` — every active skill is charged to every turn.

## Storage: `agent_skills` (cycle 74, migration 0056)

A skill is one row in **`agent_skills`** whose `content` is markdown with YAML frontmatter. That
markdown is the single source of truth. The other columns are **derived** on every write and
never edited directly. Before cycle 74 skills were documents (`type='skill'` at
`/projects/mymind/skills/<name>.md`). They moved out so living agent config doesn't mix with
project docs (spec D7).

- **Columns:** `id`, `slug` (unique; the skill's name and its `/` command), `content`,
  `content_hash` (sha256, the CAS token). Derived: `name`, `description`, `when_to_use`,
  `active` (default true), `source` (`human`/`agent`). Plus `created_at` and `updated_at`.
- **The file:**
  ```markdown
  ---
  name: deploy-and-migrate
  description: How this app is built, deployed, and migrated.
  when_to_use: Use when asked to deploy, when a deploy fails, or before running a migration.
  active: true
  source: human
  ---
  # deploy-and-migrate
  …procedure…
  ```
  - `name` is kebab-case and shares the slash-command grammar (`COMMAND_NAME_RE`, reserved
    command names excluded).
  - `description` and `when_to_use` must be non-empty.
  - The body is at most 20,000 chars.
  - Invalid content is **rejected at write** (400 / tool error). Nothing invalid is stored.
- **Revisions:** every create, edit, revert and delete writes an `agent_config_revisions` row
  (`target_kind='skill'`, actor `human`/`agent`/`system`, last 100 kept). Deleting records a final
  revision, and undo restores the **original id** with its history (`restoreSkill`).
- **The data move** is the boot plugin `server/plugins/agent-skills-migrate.ts`
  (`migrateSkillsFromDocuments`). It is idempotent. For each live `type='skill'` document under
  the legacy folder whose basename is not already a slug in `agent_skills`, it inserts the row,
  soft-deletes the document and records a `system` revision, all in one transaction. A document
  that fails is skipped and reported, and stays in place. **Every other live `type='skill'`
  document is reported too**, by path, with the reason: one whose slug already exists in
  `agent_skills`, or one outside `/projects/mymind/skills/` (moved with `move_document`). Nothing
  moves those and Bridget no longer reads skill documents, so the `[agent-skills-migrate] skipped
  <path>: <reason>` boot-log line is the only trace. Rolling back past this move needs the
  un-delete SQL in [agent-runtime.md § Rollback](agent-runtime.md#rollback). It is a plugin rather than SQL because
  rebuilding markdown from jsonb frontmatter plus body is fragile in SQL. Nitro does not await
  plugins, so on the very first boot there is a window of a few milliseconds with an empty skills
  index.
- `server/services/skills.ts` is the only module that knows this mapping. `listSkills`,
  `getSkill`, the prompt's Tier-1 index, `use_skill`, the slash-command skill tier and MCP all read
  `agent_skills`.

## Autonomy & safety

**Agent-authored skills are active immediately.** There is no approval/review gate — the speed of self-improvement is the point. Safety is structural:

- **Validation** (`validateSkill` in `server/services/skills.ts`): kebab-case name, non-empty description/whenToUse/body, body ≤20,000 chars. Structural only — nothing about content.
- **Undo**: `create_skill`, `edit_skill`, `delete_skill` all carry undo via the tool handler.
- **Revisions**: every write is a revision you can diff and revert on `/skills/[slug]`.
- **Live events**: every write publishes `publishChange({ resource: 'agentSkill', … })`, which invalidates `['skills']` and the slash-command list.
- **Headless runs**: `create_skill` and `edit_skill` are `propose` in background runs (a `/review` card), and `delete_skill` is destructive, so it is proposed too. Only interactive runs write skills directly.
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

- **`GET /api/skills`** lists all skills, ordered by name.
- **`POST /api/skills`** creates a skill from structured `SkillInput`.
- **`PUT /api/skills/:name`** is a partial structured patch. **`DELETE /api/skills/:name`**
  deletes.
- **`GET /api/skills/:name/source`** returns `{ id, slug, content, contentHash, active, source,
  updatedAt }`.
- **`PUT /api/skills/:name/source`** takes `{ content, expectedHash }`. It is a CAS save of the
  whole markdown and creates the skill when `expectedHash` is null. It returns 409
  `{ current }` on a stale hash, 404 when an update targets a missing skill, 400 when the
  content is invalid or the name malformed, and 200 on both create and update.
- **`GET /api/skills/:name/revisions`** and **`POST /api/skills/:name/revert`**
  (`{ revisionId }`) restore a revision as a new one.
- **`GET/PUT /api/settings/skills-enabled`** is the kill switch (`{ enabled }`).

## UI

- **`/skills`** (main nav, `app/pages/skills/index.vue`) shows the global **Skills enabled**
  kill switch in the header, a **New skill** dialog (a name, then a starter file), and one card
  per skill: name, description, when-to-use, a `human`/`agent` source badge, an **active** switch and
  the updated time. The switch (like `edit_skill` with only `active`) rewrites just the `active:`
  line of the stored markdown (`setFrontmatterKey`), so extra frontmatter keys and formatting
  added in the raw editor survive. An `updateSkill` that changes any other field regenerates the
  file from fields and drops them.
- **`/skills/[slug]`** (`app/pages/skills/[slug].vue`) is the shared `MarkdownConfigEditor`
  (raw CodeMirror, preview, split) plus `RevisionsPanel` (diff against the previous revision,
  **Revert**). It has explicit **Save** (button or ⌘S), no autosave. A "Not saved: <error>"
  message clears on the next edit. Revert is disabled while the editor is dirty. There is a
  **Delete skill** button and a `beforeunload` guard. The view mode is persisted in the
  `mm.config.viewMode` cookie, shared with `/jobs`.
- The Settings "Agent Skills" tab is gone (`SkillsTab.vue` and `pages/settings/skills.vue` were
  deleted).
- The revisions column is hidden below the `lg` breakpoint. There is no mobile layout for it yet.

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

These are installed with `source: 'human'` (so you can decide whether to delete them) and `active: true`. Updating a seed rewrites the whole skill (idempotent) and records a `system` revision. Environments that already had the seeds as documents get them moved into `agent_skills` by the boot plugin, so re-seeding is not required.

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
