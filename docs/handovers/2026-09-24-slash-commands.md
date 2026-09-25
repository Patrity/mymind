---
title: Slash commands — one `/` grammar over three sources, and server-side skill dispatch
cycle: 71
date: 2026-09-24
status: built
branch: worktree-cycle-70-memory-assembler
merged: false
deployed: false
specs:
  - ../superpowers/specs/2026-09-24-slash-commands-design.md
plans:
  - ../superpowers/plans/2026-09-24-slash-commands.md
wiki:
  - ../wiki/agent.md
  - ../wiki/agent-context.md
migrations:
  - 0052 prompt_commands
migrations_run_on_prod: false
---

# Cycle 71 — slash commands

**Built on `worktree-cycle-70-memory-assembler`, the same branch as cycle 70** (they merge
together). NOT merged, NOT pushed, NOT deployed. Migration 0052 is applied to the DEV database
only.

## What shipped

A `/` at the start of the composer opens a command menu, exactly the way Claude Code and
claude.ai behave. Three sources merge into one namespace with precedence **code > prompt >
skill**:

| Kind | Source | How it runs |
|---|---|---|
| `client` | `CLIENT_COMMANDS` in `shared/types/commands.ts` | client-side behaviour (`/clear`, `/new`) |
| `prompt` | `prompt_commands` table (migration 0052) | template expands **client-side** into the message text |
| `skill` | MyMind skill documents | name travels on the WS frame; the **body is loaded server-side** into the assembled context |

The design decision Tony corrected mid-cycle is the one that matters: it is
**`/browser-testing`**, not `/skill browser-testing`. A skill is a first-class command name in
the same flat namespace as everything else, so there is no separate trigger to learn.

### Why skills load server-side and prompts expand client-side

A prompt command is *text the user is sending* — expanding it client-side means the composer,
the persisted transcript and the model all agree on what was said, and a fork/edit of that turn
replays correctly. A skill body is *instruction the agent needs* and can run to thousands of
characters; putting it in the message would pollute the transcript, the conversation title and
every later summary. So the skill name rides the WS frame (`{type:'text', …, skill}`) and
`assembleContext` pushes the body as a **fixed tier**, first, ahead of resident/live/summary.

Verified on the running app: a `/incident-triage` turn persisted as `say READY and nothing else`
(prefix stripped) while `memory:assemble` telemetry jumped to `used: 471` against 269/239 for
ordinary turns — a +202-token delta against a 932-char (≈245-token) skill body. The body reaches
the model; an index entry would have been ~20 tokens.

## Files

- `shared/types/commands.ts` — `CommandKind`, `CommandEntry` (with `shadows?: CommandKind[]`),
  `CLIENT_COMMANDS`, `RESERVED_COMMAND_NAMES` (derived, so a new client command reserves its own
  name without a second edit)
- `server/lib/commands/merge.ts` — the pure precedence merge, with a same-kind guard so an entry
  can never shadow itself
- `server/db/schema/prompt-commands.ts` + migration `0052_exotic_wendigo.sql`
- `server/services/commands.ts` — `listCommands(q?)` merges the three sources
- `server/api/agent/commands.get.ts` — 5-line handler over the service
- `app/lib/agent/slash.ts` — the pure trigger rules: `shouldOpenMenu`, `applySelection`,
  `nextHighlight` (wrap-around), `shouldInterceptEnter`
- `app/composables/useCommands.ts` — vue-query `['agent','commands']` + `commandsOrFallback`
- `app/utils/live-dispatch.ts:65` — `['agent','commands']` added to the `document` override, so
  creating or editing a skill document refreshes the menu live
- `app/components/agent/PromptInput.vue` — the menu and the keyboard bridge
- `app/components/ai-elements/prompt-input/PromptInputTextarea.vue` — declared `keydown` emit +
  an `e.defaultPrevented` guard in the Enter branch
- `server/lib/agent/assemble.ts` — the skill tier, `SKILL_TIER_MAX_CHARS`, `capSkillBody`

## What the reviews caught

**The vendored `Command` wrapper cost three fix rounds.** shadcn-vue's `Command`/`CommandItem`
gate item visibility on a `filterState` that only `CommandInput` populates — and we deliberately
never mounted `CommandInput`, because the composer's own textarea is the input. The menu rendered
nothing while passing two reviews and two fix rounds green. Replacing it with a plain
`<ul role="listbox">` worked first try.

Tony's read of this was correct and worth writing down: *"this doesn't seem like a hard feature to
get right."* It wasn't. The mistake was reaching for a component because it was already in the
repo, and paying for that three times before looking at why it didn't fit. A repo-wide sweep
(including every cognova repo) found no prior art to copy — the component's presence was the only
reason it got picked.

**Two unbounded inputs to a fixed budget** (`2e78ab4`, found by the Task 7 review):
`capSkillBody` returned 8005 chars for an 8000-char cap — the `"\n\n…\n\n"` joiner was added back
*after* halving — and `listResidentMemories` had no `LIMIT` at all. Both feed `fitBudget`'s
`fixed` array, which is **all-or-nothing**: if the fixed tiers overflow, `assembleContext` drops
*every* one of them, including a skill the user named explicitly. Capping at the source is the
fix; the caller cannot recover. `RESIDENT_MEMORY_LIMIT = 40`, ordered most-retrieved first so the
cap sheds the memories least reached for. Both tests were verified to fail when the bound is
removed.

## Validated on the running app (dev, port 3070)

- Menu opens on a leading `/`, filters as you type, Enter selects, arrow keys wrap
- Escape dismisses and **keeps the typed text**; Shift+Enter inserts a newline and does not select
- A `/` mid-text does not open the menu (`what about /dep` stays a plain message)
- `GET /api/agent/commands` → 200, 9 entries across all three kinds
- Precedence: a `prompt` row named `incident-triage` resolved as `kind: prompt` with
  `shadows: ['skill']` — one entry, not two
- An `active: false` prompt command never appears
- `?q=` is parameterized: `%' or 1=1 --` returns `[]`, not the whole table
- Prompt expansion reaches the DB: the persisted user message was the template plus the appended
  args, not `/v71-recap`
- `/clear` writes `context_epoch_at`, empties the transcript pane, and persists **no** turn —
  the conversation list keeps its rows, which is the approved "Bridget forgets, DB keeps" shape

## Deferred

Carried forward from cycle 70 and still open:

- Wire `turns` into `assembleContext` so budget eviction actually runs
- `/review` handlers for the three new concern kinds
- A writer for `conversations.summary`
- Route conversation enrichment through `resolveEnrichedMemory`
- The `.db.test.ts` constant-embedding stub hazard (a stubbed `$fetch` returns one fixed vector,
  so `createMemory` merges any two rows sharing `(scope, project)` — tests needing distinct rows
  must bypass it)
- Plumb `contextEpochAt` into `ConversationDTO` so the epoch divider survives a reload

New from this cycle:

- There is **no UI for `prompt_commands`** — rows are insert-only via SQL. The table, service and
  merge are built and tested; a settings screen is the obvious next slice.
- `capSkillBody` trims head+tail. For a long skill that puts its steps in the middle, that is the
  wrong half to keep. No skill is near the cap today, so this is a real but unpressing limitation.
