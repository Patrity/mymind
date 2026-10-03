---
title: "Bridget toolsets — a small always-on core, everything else loaded on demand (cycle 78)"
cycle: 78
date: 2026-10-03
status: spec
supersedes: null
builds_on: 2026-09-30-bridget-self-improvement-design.md
---

# Bridget toolsets (cycle 78)

Bridget is moving toward connectors (Gmail, Calendar, GitHub, arbitrary MCP servers). Today every
tool's schema is sent on every step: about 53 tools in `bridgetProfile`. Adding connectors flat
would push that past 80 on a small local reasoning model (qwen) that already picks worse as the
list grows. Agent harnesses that run on small models do not do this: OpenClaw keeps about 25 core
tools and reaches the rest through skills read on demand; Hermes groups tools into toolsets that
are enabled per platform and filtered per MCP server.

This cycle is **cycle 1 of the connectors programme** (see §9). It changes no tool's behaviour.
It only changes which schemas the model sees on each step.

## 1. Decisions (brainstorm, 2026-10-02 → 10-03)

| # | Decision | Rejected |
|---|---|---|
| D1 | Every tool belongs to exactly one **toolset**. Toolsets are either **core** (always visible) or **on demand**. | flat list; tiering per tool |
| D2 | **Bridget loads toolsets herself**, mid-turn, with a `load_toolsets` tool. Tony never arms anything. (The 2026-07-01 removal of the bridget/powerful split stands: friction for Tony is the thing we are not bringing back.) | a UI toggle; per-profile fixed lists |
| D3 | A call to a real tool whose toolset is not loaded **runs** and loads its set. The directory is a hint, not a lock. | erroring with "call load_toolsets first" |
| D4 | Loaded toolsets **persist on the conversation** for its later turns. | per-turn loading |
| D5 | Jobs may declare `toolsets` that are loaded at run start. | jobs discovering their tools each run |
| D6 | The split in §3 is based on prod usage (52 conversations, ~350 calls since 2026-06-18) used as a tiebreaker, not as the rule. `history` is on demand. | keeping `history` core |
| D7 | Unchanged: the approval gate, the headless gate (`runtime/gate.ts`), undo, subagent registries, and `/api/mcp` (still exposes every non-dangerous tool). | |

## 2. Why the SDK makes this cheap

AI SDK v6 (`ai@6.0.198`):

- `prepareStep` may return `activeTools` for that step (`node_modules/ai/dist/index.mjs:4329`).
  `run.ts:228` already has a `prepareStep` hook.
- `activeTools` only filters what is **sent to the model** (`prepareToolsAndToolChoice`, `:1848`).
  Parsing a tool call validates against the **full** ToolSet passed to `streamText` (`parseToolCall`, `:6331`).
  So a call to a tool that is not active still parses, validates against its schema, and runs.
  D3 needs no `repairToolCall`; it only needs our wrapper to mark the toolset active.

The full ToolSet is still built once per run by `buildAiTools`. Only the per-step `activeTools`
list changes.

## 3. The toolsets

Core (always visible, ~25 schemas):

| id | tools |
|---|---|
| `memory` | search_memories, get_recent_memories, save_memory, forget_memory |
| `docs` | search_docs, search_passages, list_documents, read_document, get_document, grep_document, save_document, edit_document, edit_section, update_document |
| `tasks` | search_tasks, create_task, edit_task, delete_task, quick_capture |
| `web` | web_search, web_fetch, research_web, search_brain |
| `core` | exec, use_skill, load_toolsets |

On demand:

| id | directory line (shown in the system prompt) | tools |
|---|---|---|
| `history` | Claude Code sessions and past messages: what Tony did, when, in which project | search_sessions, read_session, search_messages, read_around_message |
| `projects` | look up, create and edit projects | search_projects, get_project, create_project, edit_project |
| `doc-admin` | move, delete or sync documents | move_document, delete_document, sync_document |
| `images` | generate or edit images on the rig | generate_image, edit_image |
| `jobs` | create, edit, run and schedule background jobs and wakes | list_jobs, get_job, create_job, edit_job, delete_job, run_job, schedule_wake |
| `skill-admin` | create, edit or delete skills | create_skill, edit_skill, delete_skill |
| `reviews` | list and decide items in Tony's review queue | list_reviews, decide_review |
| `improvements` | what Bridget has learned or changed about herself | list_improvements |
| `channels` | send Tony a message over iMessage or email | send_message |

Cycles 79–81 add `gmail`, `calendar`, `github` and one toolset per MCP server, all on demand.

Lines are final wording targets. The plan may adjust them, but every directory line must say
**when** to load the set, not only what it contains.

## 4. Data model — migration 0065 (additive)

- `conversations.active_toolsets text[] not null default '{}'`: the on-demand toolsets loaded in
  this conversation. Core sets are never stored.
- `agent_jobs.toolsets text[] not null default '{}'`: sets to load at the start of each run of the job.

Unknown ids in either column are ignored on read and logged once (a toolset may be renamed or removed).

Migration number assumes cycle 77 (`0064`, unmerged) lands first. If not, take the next free number.

## 5. Components

### 5.1 `server/lib/agent/toolsets.ts` (new)
- `TOOLSETS: Record<ToolsetId, { description: string; core: boolean }>`
- `ToolsetId` is a string-literal union, so the compiler checks every tool's tag.
- `activeToolNames(registry, loaded: Set<ToolsetId>) → string[]`: core tools plus every tool in a loaded set.
- `directoryText(loaded) → string`: one line per on-demand set, marking the loaded ones.
- `toolsetOf(name, registry) → ToolsetId | undefined`

### 5.2 `AgentTool.toolset: ToolsetId` (required)
Added in `types.ts`. Every tool in `tools.ts`, `tools/*.ts`, `subagents.ts`, `exec.ts` and
`reviews.ts` is tagged. A test asserts every tool in `bridgetProfile.tools` has a known toolset
and every non-core toolset has a directory line.

### 5.3 `load_toolsets` tool
- `toolset: 'core'`, `kind: 'read'`, not dangerous. Classified `run` in the headless gate
  (add it to `APPEND_TOOLS`, or classify it as free). Excluded from `/api/mcp`, because MCP
  clients see every tool already.
- Input: `{ ids: ToolsetId[] }` (enum-validated). Output summary: "Loaded images (generate_image, edit_image)."
- Handler: calls `ctx.loadToolsets(ids)` (new optional `ToolContext` hook). Without the hook
  (MCP, tests) it returns a no-op success.

### 5.4 `runAgent` (`run.ts`)
- New `ctx.toolsets?: { initial: ToolsetId[]; onChange?: (loaded: ToolsetId[]) => void }`.
- Keeps a per-run `loaded` set. `prepareStep` adds `activeTools: activeToolNames(registry, loaded)`
  alongside its existing `toolChoice` and steer handling.
- **Auto-load (D3):** `buildAiTools` gets a hook `onToolCalled(name)`. Before the handler runs,
  if the tool's set is not loaded, it is added and `onChange` fires. The call then proceeds
  through the normal approval and undo path.
- The forced-final and recovered-textcall follow-ups use the same `loaded` set.
- If `ctx.toolsets` is absent (subagents, existing tests), every tool is active, exactly as today.
- The "always fully armed" comments in `run.ts` and `profile.ts` are rewritten: everything is
  still available; only the visible schemas change.

### 5.5 System prompt (`prompt.ts`)
A short block after the tool guidance:

```
More tools are available in toolsets. Load one with load_toolsets before using it:
- history — Claude Code sessions and past messages: …
- images — generate or edit images on the rig  (loaded)
…
```

It is rebuilt every turn from the conversation's loaded sets. It is short (about 10 lines) and
has no per-tool detail.

### 5.6 `runtime/runner.ts`
- Reads `conversations.active_toolsets` before the turn. For a job run, it adds the job's
  `toolsets` (looked up via `agent_runs.job_id`).
- Passes `ctx.toolsets.initial`. `onChange` writes the new array back to the conversation
  (fire-and-forget with a logged failure; losing one write only costs a reload next turn).
- Headless runs: `headlessTools()` still classifies the whole registry. `activeTools` is
  computed from the already-gated registry, so an excluded tool can never become visible.

### 5.7 Jobs
- `create_job` / `edit_job` and the `/jobs/[slug]` editor accept an optional `toolsets` list
  (multi-select of on-demand sets).
- Seed jobs are left alone; none needs an on-demand set today.

## 6. Error handling
- Unknown id in a `load_toolsets` call → schema rejection (enum) and the model sees the valid list.
- A toolset that fails to persist → logged with `recordEvent({ kind: 'tool', name: 'toolsets:persist', status: 'error' })`. The turn continues.
- A call to a name that is no tool at all → unchanged (`NoSuchToolError`, existing recovery).

## 7. Measurement and testing
- **Schema tokens:** count the serialized tool schemas sent on step 1 of a fresh conversation,
  before and after. Expect about 53 → about 25 tools, recorded in the handover. The usage event
  already reports input tokens. Compare a fixed prompt on dev, same model, before and after.
- **Unit:**
  - every tool is tagged, and only known ids exist;
  - `activeToolNames` covers core plus loaded sets;
  - `prepareStep` returns the expected `activeTools`;
  - auto-load fires `onChange` and the handler still runs;
  - a headless-excluded tool never appears in `activeTools` even if its set is loaded;
  - `load_toolsets` without the hook is a no-op.
- **Integration (fake streamText):** a step calls `load_toolsets({ids:['images']})`, the next
  step's `activeTools` includes `generate_image`; a direct call to `generate_image` with no load
  succeeds and persists `images`.
- **Mutation check:** break the auto-load branch and watch its test go red (see memory
  "vacuous tests pass without reaching code").
- **Browser (playwright-cli):** in a new thread, ask "generate an image of a lighthouse at dusk".
  Expect the image to render; the tool chips show `load_toolsets` (or a direct auto-loaded
  call); a follow-up "make it night" in the same thread does not load again.
- **Regression:** a normal "what are my open tasks" turn uses only core tools and its answer is unchanged.

## 8. Out of scope
- Connectors (cycles 79–81).
- Unloading toolsets mid-conversation. Not needed until a thread loads many sets; revisit if
  measurement shows long threads re-bloating.
- Removing never-used tools (about 20 had zero calls). Separate decision.
- Subagent toolsets (subagents keep their fixed read-only registries).
- MCP tool exposure changes.

## 9. Connectors programme (context, decided in the same brainstorm)

| Cycle | Scope |
|---|---|
| 78 | **Toolsets** (this spec). |
| 79 | **Connections + Google, on request.** better-auth `socialProviders.google` used **only through `linkSocial`** (no Google sign-in; sign-up stays disabled), `accessType: offline` + `prompt: consent`, `account.encryptOAuthTokens`, `accountLinking.allowDifferentEmails: true`. Multiple Google accounts per user work (the link callback looks up by Google user id, `better-auth/dist/api/routes/callback.mjs:228`). A thin `connections` table keyed to `account.id` (label `work`/`personal`, default send-from, health). Tony's work Workspace trusts the app in the admin console; personal Gmail uses the unverified-production consent screen (token-expiry behaviour to confirm in that cycle's spec). `gmail` toolset: search/read/draft plus `send` (dangerous, confirmed every call, never allowlistable). `calendar` toolset: list/create/update. Reads merge all accounts and tag the source; writes must name an account. Token loss when `BETTER_AUTH_SECRET` rotates is noted in `DEPLOYMENT.md`. |
| 80 | **Proactive.** Morning brief, email → triage `/input`, meeting prep. Runs that read external content can only propose writes; external content is marked untrusted in context. |
| 81 | **GitHub + long tail.** `gh` through `exec` plus a skill and a token in exec secrets (also covers the GitHub-commits → memory backlog item); a generic MCP client whose servers become on-demand toolsets with include/exclude filters. |
