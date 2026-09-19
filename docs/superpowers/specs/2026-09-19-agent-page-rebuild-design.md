---
title: /agent rebuild on AI Elements — Persona, PromptInput, inline approvals, context meter; retire the particle head
cycle: 65
date: 2026-09-19
status: spec — approved in brainstorm, not yet planned
mymind_id: 10739fe8-527c-4c86-9c7a-21c28fe59847
mymind_hash: 06d848d046d153422a0cf69bd2a974be7c1f647a2f01323259955769b220372d
program: >
  Cycle 2 of 4 in the "agent surfaces on AI Elements" program. Cycle 64 (foundation) moved the
  conversation onto AI SDK UIMessages rendered with AI Elements Vue; this cycle rebuilds the page
  around it. Next: 66 (/sessions/[id] on Elements), 67 (voice studio + Home on shared pieces).
related:
  - ../specs/2026-09-19-agent-elements-foundation-design.md (cycle 64 — the protocol, the Elements bridge, the conversation components)
  - ../../handovers/2026-09-19-agent-elements-foundation.md (cycle 64 handover — deferred items this cycle picks up)
  - ../../wiki/agent.md, ../../wiki/voice-agent.md
closes:
  - "The particle-head face (cycle 60) — Tony: 'too hard to get looking right, never liked the end result'"
  - "Exec approvals render as a detached banner; the tool just says Running (cycle 64 validation)"
  - "Approval banner outlives Stop; server 'new' doesn't abort the running turn (MyMind task 26fc248c)"
  - "No visibility into how full the model's context is"
defers:
  - "Elements mic-selector / voice-selector / audio-player shared with /voice — cycle 67"
  - "/sessions/[id] on Elements — cycle 66"
  - "Cost in the context meter (the tokenlens catalog) — we already have LiteLLM prices in analytics; not needed here"
  - "Audio-reactive Persona — Persona is state-driven only"
out-of-scope:
  - "Subagents inheriting the model picker / mid-stream failover (MyMind task 6c72627d)"
  - "The deploy in-place .output flaw (MyMind task c490f44a)"
---

# /agent rebuild on AI Elements (cycle 65)

## Why

Cycle 64 put the conversation on AI Elements. The page around it is still cycle 60's: a
three-column shell whose right column is a particle-head "face" Tony never liked, a Nuxt UI
composer, a model picker in the header, and exec approvals as a banner detached from the tool
they belong to. This cycle rebuilds the page from Elements so the whole surface is one system,
and replaces the face with Elements' **Persona** — the option Tony chose in the cycle-64
brainstorm ("Persona + the loop inline").

## Decisions (locked in brainstorm)

| # | Decision | Choice |
|---|---|---|
| D1 | Layout | **Two panels (threads + conversation). Persona is a hero in the empty thread, a small live Persona in the composer during a conversation, and large in full-bleed voice mode.** The right "Bridget" column is removed. |
| D2 | Persona variant | **Picker in the voice settings slideover, obsidian default**, cookie-persisted with the other voice settings. |
| D3 | Approvals | **Inline on the tool part** via the SDK's approval state and Elements Confirmation; Stop / barge-in / new conversation auto-deny server-side. |
| D4 | Approach | **Compose the page from Elements** (Persona, PromptInput, Confirmation, Context, Suggestions) behind thin `Agent*` wrappers; logic in pure `lib/` functions. Not the minimal swap; not pulling cycle 67's voice selectors forward. |
| D5 | Context meter | Tokens in use vs the answering model's context window. **No cost** (no `tokenlens` catalog, no bundle weight). |
| D6 | Persona assets | Rive wasm **self-hosted**; `.riv` animation files **loaded from Vercel's URL** (as upstream does) — their license is unstated and the repo looks public, so they are not committed. CSS fallback when they can't load. |

## Facts established in brainstorm

- AI Elements Vue ships `persona` (Rive `@rive-app/webgl2`; states `idle | listening | thinking |
  speaking | asleep`; variants obsidian, mana, opal, halo, glint, command; `.riv` URLs on
  `ejiidnob33g9ap1r.public.blob.vercel-storage.com`; emits `load`/`loadError`/`ready`), `prompt-input`
  (textarea, attachments with drop/paste, tools, select, submit with `status`), `confirmation`
  (renders from a tool part's `approval` + `state`), `context` (`usedTokens`, `maxTokens`, `usage`,
  `modelId`; its cost rows import `tokenlens`), `suggestion`.
- Verified against the installed `ai` v6 `readUIMessageStream` (2026-09-19): `tool-input-available →
  tool-approval-request → tool-output-available | tool-output-denied | tool-output-error` are all
  accepted; the part carries `approval: { id }`; a pending approval stays `approval-requested`.
- `three` stays in the app (Galaxy uses it); only the agent page stops loading it.
- `MicBand.vue` depends on `lib/viz` only for a colour palette.
- The model registry (`ModelDef`) has no context-window field; local Qwen isn't in any public
  catalog.
- Production builds at a 4096 MB heap with < 512 MB headroom (cycle 64) — bundle weight is gated.

## Scope

In: the layout; Persona wrapper, hero/inline/full placements, variant picker; PromptInput-based
composer (attachments, model select, speak toggle, context meter, mic, send/stop, `?q=` auto-send,
starter prefill); Suggestions empty state; inline Confirmation + the approval stream event +
auto-deny; context accounting (`contextTokens`, `modelDefId`) and `ModelDef.contextWindow`; the
mic band's new placement; full-bleed voice mode on Persona; deletion of the avatar subsystem.

## Task 0 — spike (gate)

Install the Elements `persona`, `prompt-input`, `confirmation`, `context`, `suggestion` (+ their
shadcn primitives) through the same bridge as cycle 64 (patch any `bg-secondary` → `bg-elevated`;
explicit imports; no auto-import). Then prove, on the dev fixture page:
1. Persona renders client-only in Nuxt with Rive's wasm served from **our** origin (Nitro
   `publicAssets` entry `rive`, like `vad`/`ort`; the runtime pointed at it before first use), and
   the `.riv` loads from Vercel's URL (check no CSP/header blocks it). All five states and all six
   variants switch live; light + dark.
2. `loadError` fires when the `.riv` URL is unreachable (e.g. a bogus variant URL in the fixture) so
   the fallback path is real.
3. The Context component renders with `tokenlens`-dependent rows removed or patched out (no
   `tokenlens` dependency added).
4. **Build gate:** the `deploy.yml` build command at 4096 MB passes; record client JS gzip + chunk
   count before/after (`.claude/rules/web-nuxt.md`). If Rive pushes the build over, stop and report.

Stop the cycle if Persona cannot load its wasm from our origin or the build gate fails.

## Architecture

### Page (`app/pages/agent/index.vue`)
Two `UDashboardPanel`s: `agent-threads` (the rail, as today) and `agent-conversation` (grow). The
Bridget panel, `showBridgetAvatar`, and the avatar/mic-band mounts in it are removed. The toolbar
(`AgentToolbar`) keeps: thread title, threads button (under lg), voice-mode button, the settings
slideover trigger; the model `USelectMenu` moves into the composer.

### `AgentPersona.client.vue` (new) — wraps Elements Persona
- Props: `state: VoiceState`, `connected: boolean`, `size: 'hero' | 'inline' | 'full'`.
- `personaState(state, connected)` (pure, `app/lib/agent/persona.ts`): `!connected` or `connecting`
  → `asleep`; `idle` → `idle`; `listening` → `listening`; `thinking | tool | typing` → `thinking`;
  `speaking` → `speaking`.
- Variant from `useVoiceSettings().settings.personaVariant` (new field, default `'obsidian'`,
  validated against the six names; unknown → obsidian).
- On `loadError` (or no WebGL2), render a CSS fallback (a softly pulsing disc whose animation
  reflects the same mapped state) and `console.warn` once.
- **Exactly one Rive canvas mounted at a time:** hero (empty thread), inline (composer, while the
  thread has messages), or full (voice mode — which unmounts the inline one), mirroring today's
  single-avatar guard.

### Empty thread — `AgentEmptyState` (rewritten)
Hero Persona, the greeting, and Elements `Suggestions` for the existing four starters (click →
composer prefill, as today).

### `AgentPromptInput.vue` (new) — replaces `app/components/voice/Composer.vue`
Built on Elements PromptInput:
- Textarea: Enter sends, Shift+Enter newline; `initialText` + `autoSend` (`?q=` hand-off) and
  `prefill` (starters) preserved with today's semantics.
- Attachments: picker (PromptInputActionAddAttachments), drag-drop, paste. Today's rules kept
  verbatim — images, PDFs and text types; ≤ 20 MB each; max count as today. On submit, each file is
  uploaded as today (`/api/upload` for images → `{id}`; `/api/agent/files` for other files) and the
  resulting `AttachmentRef[]` goes to `sendText`. The PromptInput→upload adapter (blob URL / `File`
  → `AttachmentRef`) is a pure-ish helper in `app/lib/agent/attachments.ts` with the validation
  rules moved out of Composer.
- Footer tools, left to right: inline `AgentPersona` (when the thread has messages), model select
  (PromptInputSelect: "Default (chain order)" + the reasoning-assigned models; same cookie + the
  `__default__` sentinel as today), speak toggle, `AgentContextMeter`, mic toggle, PromptInputSubmit
  (`status` = `streaming` while busy → acts as Stop; emits `stop`).
- Upload failure: toast, text + files kept (as today).

### Mic band
`AgentMicBand` (kept; its palette import moves from `lib/viz/tuning` into the component) renders as
a slim row directly above the composer while the mic is on, and in voice mode.

### Voice mode (full-bleed)
Overlay as today, with `AgentPersona size="full"` instead of the avatar, the caption
(`MessageResponse`), and the mic band. Escape / minimize exits.

### Inline approvals
- `AgentToolPart` renders Elements `Confirmation` when `part.state === 'approval-requested'`:
  title "Run this?" with the command, an editable "always allow" pattern (pre-filled with
  `proposedPattern`), a "remember" checkbox, Approve / Deny. Details come from
  `voice.pendingApproval` matched on `part.approval.id === requestId`; if absent, it shows
  "Approve `<toolName>`?" with the input JSON and still works.
- Approve/Deny call `voice.sendApproval(requestId, approved, { remember, pattern })` (unchanged).
- `app/components/agent/ApprovalPrompt.vue` and its mount on the page are deleted.

### Context meter — `AgentContextMeter.vue` (new)
Elements `Context` with its cost rows removed (vendored components patched; `tokenlens` not
installed). `contextMeterData(messages, models, selectedModelId)` (pure, `app/lib/agent/context-meter.ts`):
`usedTokens` = the latest assistant message's `metadata.usage.contextTokens`; `maxTokens` = the
`contextWindow` of `usage.modelDefId` ?? the selected override ?? the reasoning chain head;
unknown window → show the count without the ring; no usage yet → the meter is hidden.

### Server & data
1. **Approval stream event.** `ApprovalRequest` gains `callId` (filled in `ai-tools.ts` from
   `opts.toolCallId`). `VoiceEvent` gains `{ type: 'approval-request'; approvalId; callId; name }`.
   `ws.ts`'s `requestApproval`, when it must ask a human, emits it into the current turn's stream
   (a connection-scoped reference to the active `TurnStream`) in addition to today's `approval`
   frame. The encoder maps it to `{ type: 'tool-approval-request', approvalId, toolCallId }`, first
   emitting `tool-input-available` (input `{}`, the event's `name`) if that call was never opened.
   Allow-listed calls emit nothing (unchanged behaviour).
2. **Auto-deny.** A pure helper `denyPendingApprovals(state)` (clears timers, resolves each pending
   approval `{ approved: false }`, clears the map) is used by the existing new-turn path AND by the
   `interrupt` and `new` control frames. `new` also aborts the running turn (`s.ac?.abort()`).
   Closes MyMind task 26fc248c.
3. **Context accounting.** `runAgent` records the usage of the **last** `finish-step` part it sees
   (main stream, and the forced-final follow-up, which supersedes) and the `modelDefId` of the model
   that produced the stream. Its `usage` event gains `contextTokens` (that step's input + output
   tokens) and `modelDefId`. `reasoningModels` returns the resolved ids alongside the model instances
   so the chosen id is known. `MessageUsage` gains `contextTokens?: number` and `modelDefId?: string`
   (jsonb, additive — no migration); the orchestrator/turn stream pass them through to
   `message-metadata` and persistence unchanged otherwise.
4. **Context window.** `ModelDef` gains `contextWindow: number | null` — registry `types.ts`,
   `schema.ts` (`z.number().int().positive().nullable()`, default `null` for existing docs), `resolve`,
   the client `DraftModel`, and a "Context window (tokens)" field in `ModelForm.vue`.
5. **Rive wasm.** New Nitro `publicAssets` entry `{ baseURL: 'rive', dir: <@rive-app/webgl2 package
   dir>, maxAge: 30d }`, resolved like the VAD entries.

### Client state
- `finalizeMessage` treats `approval-requested` as dangling → `output-error` "Stopped".
- `useVoice`: the viz emitter (`events`, `onVizEvent`, `VizEvent` imports) is removed; `micAnalyser`
  / `outAnalyser` stay (MicBand). `useVoiceSettings` gains `personaVariant`.
- `SettingsSlideover.vue` gains the Persona variant select.

### Deleted
`app/components/agent/Avatar.client.vue`, `app/components/agent/ApprovalPrompt.vue`,
`app/components/voice/Composer.vue`, `app/lib/avatar/**`, `app/lib/viz/**`, `scripts/bake-head.ts`,
`scripts/blender-export-head.py`, `app/assets/head-points.bin`, the `bake:head` package script, and
`docs/DEPLOYMENT.md` §12's head-bake gotcha. (`three` stays — Galaxy.)

## Errors and edge cases

- Persona `.riv`/wasm load failure or no WebGL2 → CSS fallback; warn once; nothing else breaks.
- Vercel's `.riv` host unreachable/removed → same fallback (documented operational note).
- Approval details frame missing → minimal Confirmation (tool name + input JSON), still functional.
- Stop / barge-in during an approval → server denies; the tool part finalizes "Stopped"; the next
  turn is not blocked by a pending approval.
- Old threads (no `contextTokens`) → meter hidden until the next turn.
- Model without `contextWindow` → count only.
- Upload failure → toast; text + files kept.
- Mobile (< lg): threads in the slideover as today. Below `sm` (640 px) the model select and the
  context meter move into a PromptInput action menu ("…"); the inline Persona, attachments, speak,
  mic and send/stop stay visible. Validated at 375 px.

## Testing

- **Unit:** `personaState`; `contextMeterData`; the encoder's approval path through the real
  `readUIMessageStream` (approve → output-available, deny → output-denied, error → output-error,
  unopened call → input synthesized); `finalizeMessage` on `approval-requested`;
  `denyPendingApprovals` (+ ws wiring for interrupt/new via the helper); `runAgent`
  `contextTokens`/`modelDefId` from a fake stream with `finish-step` parts incl. the forced-final
  follow-up; registry schema accepts `contextWindow` and defaults `null`; the attachment adapter
  (validation + upload mapping) with `$fetch` stubbed.
- **Build gate** (Task 0 and final): the `deploy.yml` command at 4096 MB passes; client JS gzip +
  chunk count recorded.
- **Browser (playwright-cli)** on `/agent`, light + dark, 1440 and 375 px: empty-state hero +
  suggestions; inline Persona through a turn (thinking → idle; speaking in speak mode); inline
  approval approve, deny, and remember-pattern; Stop during a pending approval (tool "Stopped", next
  turn runs); context meter after setting a window in /settings; variant picker switches; voice
  mode (Persona full + caption + mic band); mic band above the composer with the mic on;
  attachments via picker, paste and drop (image + PDF) render in the user message; `?q=` auto-send
  from Home; resume a thread; mobile threads slideover; Persona fallback (bogus URL fixture).
- **Gates:** `pnpm typecheck`, `pnpm test`, the deploy build.

## Risks

1. **Rive in Nuxt** (client-only, wasm path) — gated by Task 0.
2. **Vercel-hosted `.riv` availability** — fallback + operational note; revisit (commission or
   license our own asset) if it ever disappears.
3. **Bundle weight** — Rive adds JS + wasm (wasm is a separate asset, not in the JS chunk graph);
   the avatar/`lib/viz` removal offsets some. Gated by the 4096 MB build.
4. **PromptInput vs our attachment semantics** (blob URLs vs uploads) — isolated in the adapter and
   unit-tested.
