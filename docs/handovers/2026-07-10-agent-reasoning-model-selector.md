---
title: Agent reasoning block + on-the-fly model selector — Cycle 45
cycle: 45
date: 2026-07-10
status: BUILT on branch feat/agent-reasoning-model-selector — gates green (typecheck 0 / 762 tests / build) + full browser E2E on dev (both features proven; a Critical dropdown bug was caught in-browser and fixed). NOT merged, NOT pushed, NOT deployed — awaiting Tony's merge/deploy decision. Migration 0026 applied to local dev; prod runs it in CD on deploy.
branch: feat/agent-reasoning-model-selector (built subagent-driven, 6 impl tasks + controller browser E2E + ship; per-task two-verdict review; final whole-branch review opus = Ready to merge)
docs:
  - ../wiki/agent.md (living reference — updated: reasoning block, model override, WS frames, conversation_messages.reasoning; cycle bumped 42→45)
  - ../superpowers/specs/2026-07-10-agent-reasoning-and-model-selector-design.md (spec)
  - ../superpowers/plans/2026-07-10-agent-reasoning-model-selector.md (plan)
  - ../superpowers/plans/00-roadmap.md (cycle-45 row)
problem: >
  Origin: prod bulk-usage errors ("no data returned") were traced to Qwen3.6's hybrid reasoning —
  the openai/-prefixed LiteLLM alias emits reasoning_content and, under a tight max_tokens cap, burns
  the budget thinking and returns null content, which extractContent throws on (rescued by the chain's
  no-think fallback). Tony fixed the bulk config himself, then asked for two agent-chat features:
  (1) surface the reasoning_content the AI SDK already parses (currently dropped) as a collapsible
  "Thinking" block; (2) a UI dropdown to switch the reasoning-role model on the fly.
keydecision: >
  Both features ride the WS pipeline only (the SSE /api/agent/chat + useTextChat path is unused by the
  page). Reasoning is PERSISTED per assistant message (conversation_messages.reasoning, migration 0026)
  but is display/storage ONLY — getAgentHistory still selects role+content, so it never re-enters the
  model's context (prompt cost flat). The model override is EPHEMERAL and connection-level: a cookie
  (agent-model) → WS {type:'model',modelDefId} frame → pure reorderChain() that moves the chosen model
  to the front of the resolved reasoning chain with the rest kept as failover. It never writes ai_config.
---

# Cycle 45 — Agent reasoning block + on-the-fly model selector

## What shipped

Two additions to `/agent`, both WS-pipeline-only.

### 1. Reasoning "Thinking" block
The reasoning model's `reasoning_content` (a `<think>` channel, distinct from the answer) is now surfaced instead of dropped.

- **`server/lib/agent/run.ts`** — new `AgentEvent` `{type:'reasoning-delta', text}`, yielded from the AI SDK `fullStream` `reasoning-delta` parts (read `part.delta ?? part.text`).
- **`server/lib/voice/orchestrator.ts`** — new `VoiceEvent` `{type:'reasoning', text}`. Emitted only; **never chunked/spoken, never appended to `assistantText`**. So voice turns don't read the thinking aloud, and reasoning never enters the returned `AgentMessage`.
- **`server/api/voice/ws.ts`** — accumulates reasoning in the `emit` closure (same seam as `tool_calls`) and persists it on the assistant row via `appendMessages`.
- **Persistence** — `conversation_messages.reasoning text` (nullable), migration **0026_shallow_madrox.sql** (single `ADD COLUMN`). `msgToDTO`/`getConversation` return it for UI hydration; **`getAgentHistory` stays role+content only** — the invariant that reasoning never reaches the model.
- **Client** — `app/lib/voice/messages.ts` maps the frame; `useVoice.pushReasoning` attaches it to the current assistant `TranscriptEntry.reasoning`. `app/components/agent/ReasoningBlock.vue` renders a collapsible **Thinking** `<details>` above the answer (muted `whitespace-pre-wrap`, not MDC). Auto-opens while thinking, collapses when the answer starts, manual toggle wins thereafter. Hydrated on resume so it persists across reloads.

### 2. On-the-fly reasoning-model selector
- **Server** — `reorderChain(chain, modelDefId)` (pure, in `server/lib/ai/registry/resolve.ts`): chosen model to the front, **rest preserved as failover**; unknown/null/undefined → no-op. `reasoningModels(modelDefId)` applies it; `runAgent` ctx gains `modelDefId`; `orchestrator` threads it; `ws.ts` adds `ConnState.model` + a `{type:'model',modelDefId}` control frame.
- **Client** — `useVoice.setModel` + `desiredModel` (resent on every WS reopen, like the voice pick). `app/pages/agent/index.vue` adds a navbar `USelectMenu` listing the reasoning chain from `useAiConfig` + a **"Default (chain order)"** entry, cookie-backed (`agent-model`).
- **Ephemeral**: lives in `ConnState.model` + the cookie; **never writes `ai_config`**. Subagents do NOT inherit the override (deliberate scope boundary).

## Verification

- **Gates:** `pnpm typecheck` 0 errors; `pnpm test` **762 passed** (new unit tests: run.ts reasoning-delta; orchestrator reasoning-emitted-not-TTS'd; messages.ts reasoning mapping; reorderChain front/failover/no-op cases); `pnpm build` clean.
- **Browser E2E (playwright-cli on dev).** To exercise the Thinking block live, dev's reasoning chain was temporarily pointed at the prod LiteLLM `openai/qwen3.6-35b-a3b` (thinking) alias, then **restored** afterward (dev config is back to its original two-model chain; the plaintext key used for setup was shredded).
  - **Thinking block: PASS** — rendered as a collapsible above the answer, toggled, **persisted** to `conversation_messages.reasoning` (214 chars, DB-confirmed), and **survived reload + History-resume**. (Screenshot: reasoning cleanly separated from the answer, with the model dropdown visible in the navbar.)
  - **Model override: PROVEN end-to-end** — selecting "Haiku 4.5" then the thinking alias made `activity_log.reasoning:agent.model_id` = `claude-haiku-4-5` then `openai/qwen3.6-35b-a3b` respectively (the selected model is the model that actually ran).

## The bug the browser caught (and why it matters)

The model dropdown initially used `value: ''` for the "Default" option (as the plan specified). **reka-ui's `USelectMenu`/`ComboboxItem` throws on an empty-string value**, which aborted the entire popover mount → the dropdown opened but rendered **no options**. This passed typecheck, build, and every code review — it only surfaced in the browser. Fixed (`ef18ea4`) with a non-empty sentinel `'__default__'` mapped back to `''`/`null`, re-verified in-browser (4 options render, cookie sets on pick + clears on Default). **Lesson reinforced: reka-ui item values must be non-empty; browser-validate every selector.**

## Notes / corrections

- **The SSE `/api/agent/chat` endpoint is LIVE, not dead** (registered, session-authed, used by cron/scripts). Only the *client* composable `app/composables/useTextChat.ts` is unimported. The spec/plan called the whole path "dead code" — imprecise. The endpoint only forwards `text-delta` and safely ignores the new `reasoning-delta` event, so it needed no change; if it's ever wired to a UI, add reasoning forwarding there.
- The `run.ts` reasoning branch duplicates a 3-line delta-narrowing block (mirrors the pre-existing `text-delta` pattern); the `ws.ts` frame-protocol comment now lists `{type:'model'}`; a stale `agent-model` cookie is reconciled on mount (final-review nits, applied in `09d51fe`).

## Deferred

- Reasoning-only turns (thinking with an empty final answer) aren't persisted (`handleTurn` drops empty-answer turns) — harmless for this always-answering agent.
- No live "reasoning stream" pane; no per-message model pinning in history; subagent model override.

## Next steps for Tony

1. Review the branch; when ready, merge `feat/agent-reasoning-model-selector` to master (CD runs migration 0026 on deploy).
2. Optional: assign a thinking-capable model (the `openai/`-prefixed LiteLLM alias) to the `reasoning` usage in **prod** if you want the Thinking block populated in production (dev/prod ai_config are independent; prod reasoning primary is currently the thinking alias already — see the cycle-45 investigation).
