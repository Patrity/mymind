---
title: Unified Agent Surface (/agent) + Conversation Persistence + Bridget
cycle: 28
date: 2026-06-17
status: shipped
branch: feat/agent-surface
spec: ../superpowers/specs/2026-06-17-agent-surface-chat-design.md
plans:
  - ../superpowers/plans/2026-06-17-agent-surface-chat.md
wiki:
  - ../wiki/agent.md
shipped:
  - "**Convergence**: voice + text now share one flow end-to-end. `runAgent` ctx generalized to `{ signal, speak?, profile?, context? }` — `speak` is the **sole** voice/text branch (gates TTS *and* selects prompt mode). The orchestrator (`handleTurn`) gates TTS on `speak` and emits a new `typing` state for text turns. SSE `POST /api/agent/chat` retained **headless-only** (not wired to the UI). Failover + `recordEvent` observability unchanged (diff-verified)."
  - "**Profile seam** (`server/lib/agent/profile.ts`): `AgentProfile = { id, tools, personaKey }` + `bridgetProfile` (15 tools + `agent_persona`). One profile this cycle; the shape is the entry point for Cycle B's powerful tools."
  - "**Conversation store** (`server/db/schema/conversations.ts`, migration **0022**; `server/services/conversations.ts`): `conversations` + `conversation_messages`, modality-agnostic (`modality` per message), tree-capable `parent_id` **populated linearly** (branching UI deferred), `summary_embedding halfvec(2560)` **reserved**, gin-trigram on title+content. Service: create/appendMessages(linear chain)/getConversation/getAgentHistory/listConversations(keyword)/delete/deriveTitle."
  - "**WS persistence** (`server/api/voice/ws.ts`): `ConnState` +conversationId/+context; frames `{type:'text',text,speak?}`, `{type:'load',conversationId}`, `{type:'new'}`; per-connection live context (cached, rebuilt on `new`); every turn lazily creates the conversation + appends user/assistant messages (per-message modality + collected `tool_calls`) + `publishChange`. `load` failures surface as an `error` frame."
  - "**Endpoints + composable**: `GET /api/conversations?q=` (keyword), `GET /api/conversations/[id]` (404), `DELETE /api/conversations/[id]` (publishChange deleted); `useConversations()` (vue-query, reactive keys aligned with the live-dispatch default). `conversation` added to the `ResourceName` union."
  - "**Bridget personality** (`server/lib/agent/prompt.ts` + `persona.ts` + `context.ts`): `buildSystemPrompt` composes editable persona + time-of-day tone + modality rules + live context. Persona stored in `settings.agent_persona` (cached + `DEFAULT_PERSONA` seed), edited at `/settings → Bridget` (`GET`/`PUT /api/settings/persona`, empty→400). Live context = active projects + open tasks, assembled once per connection. `composePrompt`/`timeOfDayTone` pure + unit-tested."
  - "**Client transport** (`app/composables/useVoice.ts`): WS **decoupled from the mic** — `connect()` opens the WS (no getUserMedia), `enableMic()`/`disableMic()` lazily manage VAD; `start()` is a back-compat alias (mic off). `sendText(text, speak)`, `loadConversation(id)`, `newConversation()`. Session-invalidation + barge-in + teardown preserved. New `typing` viz state wired through `VizState`/`VoiceState`/`MsgEffect` + the choreographer knob records + `PALETTE`."
  - "**UI**: `/voice` → `/agent` (routeRules). `app/pages/agent/index.vue` (canvas toggle, respond-in-voice toggle, Connect, Enable-mic, New, History slideover) + `app/pages/agent/history.vue` (keyword search, delete, deep-link to `/agent?c=`) + `app/components/agent/HistorySlideover.vue`. Composer gained a `speak` prop."
validation:
  - "Built **subagent-driven** (11 tasks; T3+T4 combined as the coupled agent-core refactor). Two-stage review per task (spec + quality); T3/T4 reviewed on opus. Important findings fixed (WS load error-surfacing; UButton history rows)."
  - "Gates: **typecheck 0 · test 399/399 (66 files) · build clean · db:migrate clean**. Lint not a gate (repo-wide red, per project norm)."
  - "**Playwright E2E PASS** against dev + the live AI rig: `/voice`→`/agent` redirect; all controls render; **Connect opens the WS with no mic prompt** + separate Enable-mic (decoupling); **full text turn** → reply *\"Evening, Tony!\"* (time-of-day tone + persona, no tools); **persisted** (1 conversation, 2 msgs, correct modality, deriveTitle title); **deep-link resume** (`/agent?c=`); `/agent/history` list + **search filter**; **persona tab** loads default + PUT persists + empty→400; **DELETE** clears the list. Test data cleaned."
  - "**Bug found + fixed by E2E** (typecheck/build passed): with both `pages/agent.vue` and `pages/agent/history.vue`, Nuxt nested `/agent/history` under `agent.vue` (no `<NuxtPage/>` outlet) so it rendered the agent shell. Fixed by moving the page to `pages/agent/index.vue` (sibling routes). Commit `9a68273`."
deferred:
  - "**Cycle B** — powerful capability tools (web research / shell / SSH / `gh` / file-edit) + execution-model/security design (tracked: mymind task `d1d7f0ab`). The profile seam is ready."
  - "Conversation **summarization worker** + **semantic search** (`summary_embedding` reserved; keyword ships now)."
  - "**Branching UI** (edit/regenerate → fork): `parent_id` edge exists; `active_leaf_id`/path-walking + UI are future. Consider a raw-SQL self-FK on `parent_id` if branching lands."
  - "Voice **audio** storage (transcript text only), command-palette integration, token-cost display, multi-profile UI."
  - "Minor (final-review): the canvas-off transcript header **duplicates** the 7-control block (extract to a small component); the slideover/history rows could share a row component."
---

# Unified Agent Surface (/agent) + Conversation Persistence + Bridget

This is **Cycle A** of the "real agent loop" theme: graduate the shared `runAgent` core into a first-class in-app assistant. It unifies `/voice` and text chat into a single `/agent` surface, persists every conversation (talk or type) as a resumable + searchable thread, and gives Bridget a real, editable, context-aware personality — all on the **current safe 15-tool surface**. The genuinely new, security-heavy capability tools were deliberately split into **Cycle B** so the execution-model/security design isn't rushed.

The headline constraint (Tony's): **minimal divergence from the voice flow**. It is enforced structurally — both modalities go through one WS → orchestrator → `runAgent`, and the only branch is the `speak` flag. The plan carried this as a per-task review gate.

See [`wiki/agent.md`](../wiki/agent.md) for how the system works today, the spec for intent, and the plan for the task breakdown. The SDD progress ledger is at `.git/sdd/progress.md`.

## Next seam

Cycle B plugs into `AgentProfile`: a "powerful" profile selects an expanded tool set + a harder prompt, gated/confirmed appropriately, with the execution model (in-process vs. sandbox vs. delegating to a real coding-agent runtime) as the central decision. Nothing in Cycle A precludes it — the entry point is parameterized and the surface is ready.
