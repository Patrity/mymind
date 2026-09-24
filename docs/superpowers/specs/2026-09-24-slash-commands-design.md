---
title: "Slash commands + skill invocation in the agent composer (cycle 71)"
cycle: 71
date: 2026-09-24
status: spec
supersedes: null
mymind_task: ea293581
depends_on: cycle 70 (docs/superpowers/specs/2026-09-23-memory-applicability-context-assembler-design.md) — built, UNMERGED
---

# Slash commands + skill invocation (cycle 71)

The agent composer has no command affordance. Everything typed is a turn, so there is no way to
clear a conversation, reuse a saved prompt, or force a specific skill — the model decides when to
load a skill via `use_skill`, and you cannot override it.

This cycle adds a flat `/` namespace to the composer, **Claude Code style**: skills are top-level
commands (`/browser-testing`), not a `/skill <name>` sub-namespace.

It also finally gives `/clear` an entry point. Cycle 70 built the epoch mechanism — the column, the
service, the model-side read — and deferred the user-facing trigger; without this cycle,
`clearConversationContext` has no production caller.

## 1. What already exists

Checked in the worktree, not assumed:

- **The command menu primitive is already vendored and unused.** `PromptInputCommand`,
  `PromptInputCommandList`, `PromptInputCommandInput` and `PromptInputCommandSeparator` exist under
  `app/components/ai-elements/prompt-input/` as thin wrappers over `app/components/ui/command/`.
  `Command.vue` is reka-ui's `ListboxRoot` with `useFilter({ sensitivity: 'base' })` — **filtering
  is already local and instant**. `app/components/agent/PromptInput.vue` imports none of them.
- **One submit funnel.** `onSubmit(msg: PromptInputMessage)` at `app/components/agent/PromptInput.vue:86`
  is where every typed turn leaves the composer. That is the interception point.
- **A documented WS protocol.** `server/api/voice/ws.ts:25-40` lists the client→server messages
  (`text`, `load`, `new`, `preset`, `model`, `approve`/`deny`). This cycle adds one.
- **A skills registry — stored as documents, not a table.** `listSkills({ activeOnly: true })` reads
  `documents` rows under `/projects/mymind/skills/<name>.md` (`skillPath`, `SKILL_PROJECT`) and maps
  them through `docToSkill`, returning `name`, `description`, `whenToUse`, `active`.
  `renderSkillsIndex` puts that index in the system prompt and the model calls `use_skill` at its own
  discretion. Skill names are already kebab-case (`SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/`),
  which maps directly onto `/browser-testing` with no transformation.
- **From cycle 70 (unmerged):** `clearConversationContext(conversationId)`, `conversations.context_epoch_at`,
  `loadActivePath(id, { sinceEpoch })`, and `assembleContext()` with its tiered token budget.

## 2. The namespace

One flat `/` namespace merged from three sources.

| Source | `kind` | Example | Editable without a deploy |
|---|---|---|---|
| Code constant | `client` | `/clear`, `/new` | no |
| New `prompt_commands` table | `prompt` | `/standup` | yes |
| Existing skills (documents under `/projects/mymind/skills/`) | `skill` | `/browser-testing` | yes (already) |

Client-kind commands stay in code deliberately: each maps to client behaviour that must exist in the
bundle anyway, and a DB row naming a WS message the client cannot send is a silent no-op.

Skills need no new storage — `listSkills` already returns exactly what a menu entry needs, and
`whenToUse` becomes the entry's secondary line. Note they are `documents` rows, not a dedicated
table; that is why freshness keys off the `document` resource (§3).

### 2.1 Collisions

A skill named `clear` would shadow or be shadowed by the built-in. Precedence is **code > prompt >
skill**. The endpoint marks a shadowed entry (`shadowedBy`) rather than dropping it, so `/settings`
can surface the conflict.

`validateSkill` (already in `server/services/skills.ts`) gains a reserved-name check, so a collision
surfaces when you name the skill — not when the command silently stops working.

## 3. The endpoint

`GET /api/agent/commands` → `{ name, description, hint, kind, shadowedBy? }[]`

Its job is the **merge and precedence**, not per-keystroke filtering. `Command` already filters
locally via reka's `useFilter`, and a round-trip per character would make the menu laggy for no gain.
`?q=` is supported for the case where the list outgrows shipping it wholesale; the composer does not
use it today.

**Freshness** uses the project's existing live mechanism: fetched with `@tanstack/vue-query`,
invalidated by `publishChange` on the **`document`** resource (`.claude/rules/live-data.md`).

Not `skill` — there is no such member of `ResourceName`, because skills *are* documents. That means
the command list invalidates on any document change, not just a skill one. Accepted deliberately:
the query is cheap, and inventing a `skill` resource to get a narrower signal would add a
`ResourceName` member that nothing else publishes. Creating a skill still makes it appear in the
menu without a reload, which is the property that matters.

**Degradation:** if the endpoint fails the menu still opens with the code-defined commands, because
those live in the bundle. A server error never costs you `/clear`.

## 4. Composer interaction

- `/` opens the menu **only as the first character of an empty input**. Not mid-text — otherwise a
  file path or a date fires it.
- Escape closes; so does deleting the `/`.
- Selecting an entry fills `/name ` and leaves the cursor after it. **It does not submit.** `/clear`
  is destructive enough that a menu click must not fire it.
- **Arguments are the rest of the line.** `/browser-testing validate the review page` sends
  "validate the review page" as the turn with the skill pre-loaded. No parsing beyond the first token.

## 5. Dispatch

All three kinds funnel through `onSubmit()`.

### 5.1 `client` — `/clear`

New WS message `{type:'clear'}`. The server calls `clearConversationContext(s.conversationId)`,
resets `s.history`, and emits `{type:'cleared', epochAt}`.

The UI renders an **epoch divider** in the transcript rather than hiding anything. This is not
decoration: cycle 70 deliberately made the model path and the UI path disagree (the model reads only
post-epoch messages, the UI still sees everything), and its ruling was that the divergence must be
*visible* rather than silent. The divider is what makes it visible.

`conversationId` null (first turn, no conversation yet) is a no-op with a toast, not an error.

### 5.2 `prompt` — expanded client-side

The command list carries the template, so the composer substitutes before submitting and sends an
ordinary turn. The transcript shows the **expanded text**, not `/standup`, so what the model received
is visible. Zero new protocol, zero server work for the kind most likely to grow.

### 5.3 `skill` — resolved server-side

The client sends `{type:'text', text, skill:'browser-testing'}`. `assembleContext` gains an optional
`skill` input; when present it resolves the body and pushes a **fixed tier** — never evicted, because
the user explicitly asked for it.

Routing this through the assembler rather than the system prompt keeps one place responsible for
prompt assembly and one budget covering everything, and the cost appears in the `memory:assemble`
telemetry that already records `used`.

**Skill bodies are capped** with the existing head/tail trim (`buildEnrichTranscript`'s helper).
`fitBudget` *throws* when the fixed tiers alone exceed the budget — deliberately, so a silently
truncated prompt cannot happen — and a skill too large to fit in a prompt is a skill that needs
splitting. Raising the budget instead would hide that.

## 6. Migration

One additive migration: `prompt_commands` (`name` unique, `description`, `template`, `active`,
timestamps). No change to `skills`, `conversations` or `memories`.

## 7. Testing

- **Merge, precedence and collision marking are pure** — unit tests, no DB.
- **Trigger rules are pure** — `/` at position 0 only, escape/delete closing, argument splitting.
- **The endpoint** gets a DB test covering all three sources and a shadowed entry.
- **`/clear` end-to-end** gets a DB test: after a clear, `getAgentHistory` excludes pre-clear content
  while `getConversation` still includes it, and the divider's `epochAt` matches the row.
- **Browser validation with `playwright-cli`, not MCP.** The menu is reka-ui: it needs **real clicks**
  (`click <e-ref>`), because a programmatic `el.click()` does not fire reka's handler. Validate that
  `/` opens the menu, that selecting fills without submitting, and that `/clear` renders a divider.
- Every test must be verified to fail when its behaviour is broken on purpose.

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | A large skill body plus resident facts plus live state exceeds the budget and `fitBudget` throws | Cap the skill body (§5.3). The throw is the correct behaviour, not the risk — the risk is an uncapped body reaching it. |
| 2 | A stale command list makes a new skill invisible to `/` | vue-query invalidated by `publishChange` on `document` (§3) |
| 3 | An accidental `/clear` loses a working context | Selecting never submits (§4); the epoch is reversible — rows are not deleted, only hidden from the model |
| 4 | Precedence silently hides a skill behind a built-in | `shadowedBy` is returned, and `validateSkill` rejects reserved names at creation (§2.1) |

## Out of scope

- **A `server` kind** — a command that runs a tool and renders a result card. The registry's `kind`
  field leaves room; nothing needs it yet and it would drag in result rendering.
- **`@`-mentions of anything** (files, documents, projects). This cycle is `/` only.
- **Editing prompt macros in-app.** The table ships; the CRUD UI is a follow-up. Rows can be added
  directly until then.
- **Command history / recently-used ordering.** Alphabetical within kind is enough to start.
