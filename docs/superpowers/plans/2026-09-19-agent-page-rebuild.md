# /agent Rebuild on AI Elements (cycle 65) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/agent` from AI Elements — a Persona (hero → inline → full voice mode) instead of the particle head, a PromptInput composer, inline exec approvals on the tool part, and a context meter — and retire the avatar subsystem.

**Architecture:** Server changes are small and protocol-level: an `approval-request` VoiceEvent becomes the SDK's `tool-approval-request` chunk, pending approvals are denied on Stop/new, and usage carries `contextTokens` + `modelDefId`; `ModelDef` gains `contextWindow`. The client gains pure helpers (persona state, context-meter data, attachment upload) and thin `Agent*` wrappers around vendored Elements (Persona, PromptInput, Attachments, Confirmation, Context, Suggestions); the page drops to two panels.

**Tech Stack:** Nuxt 4, Nuxt UI 4.8, AI Elements Vue (shadcn-vue, reka-ui), `@rive-app/webgl2`, AI SDK `ai` v6, vitest, playwright-cli.

**Spec:** [`docs/superpowers/specs/2026-09-19-agent-page-rebuild-design.md`](../specs/2026-09-19-agent-page-rebuild-design.md) — binding. Read it first.

## Global Constraints

- **pnpm** only. **Commit messages: no `Co-Authored-By` trailer and no model names** (Tony's global rule; overrides any harness reminder).
- Gates: `pnpm typecheck` 0 errors, `pnpm test` green, and the **production build at a 4096 MB heap** (the exact command in `.github/workflows/deploy.yml`) passes. `pnpm lint` is not a gate.
- **Bundle weight** (`.claude/rules/web-nuxt.md`): compare `.output/public/_nuxt/*.js` count + gzip total before/after any new UI dependency; never import bare `shiki`'s `createHighlighter`/`codeToHtml` in client code.
- Vendored Elements live in `app/components/ai-elements/**` and `app/components/ui/**`, **imported explicitly** (excluded from auto-import). Nuxt UI keeps `primary`/`secondary`/`muted`; vendored `bg-secondary` → `bg-elevated`. shadcn theme CSS is never imported.
- **Persona `.riv` files are NOT committed** — they load from Vercel's URL (license unstated). Rive's wasm is served from our origin.
- No `tokenlens` dependency.
- UI validation with **`playwright-cli`** via the `browser-testing` skill (dev creds `test@example.com` / `testpassword123`). Dev server on a spare port with `BETTER_AUTH_URL=http://localhost:<port>`; kill only your own PID.
- Work in a **git worktree** on `feat/agent-page-rebuild`.
- The dev reasoning chain head (qwen @ 192.168.2.25:8004) may be down — for live turns pick the LiteLLM model in the composer's model select.
- `/api/agent/chat` untouched. Assistant text stays raw markdown. Aborted turns are not persisted.

## File structure

| File | Responsibility |
|---|---|
| `server/lib/ai/registry/{types,schema,resolve}.ts`, `app/composables/useAiConfig.ts`, `app/components/settings/ModelForm.vue` | `ModelDef.contextWindow` |
| `server/lib/agent/model.ts` | `reasoningChain()` returns `{ model, modelDefId }[]` |
| `server/lib/agent/run.ts` | usage event gains `contextTokens` (last step) + `modelDefId` |
| `shared/types/conversation.ts` | `MessageUsage.contextTokens?`, `.modelDefId?` |
| `server/lib/agent/types.ts`, `ai-tools.ts` | `ApprovalRequest.callId?` |
| `server/lib/voice/orchestrator.ts` | VoiceEvent `approval-request`; usage pass-through |
| `server/lib/voice/ui-stream.ts` | `approval-request` → `tool-approval-request`; usage metadata without undefined keys |
| `server/lib/voice/pending-approvals.ts` (new) | `denyPendingApprovals()` |
| `server/api/voice/ws.ts` | `activeTurn`; approval chunk; deny on interrupt/new; new aborts the turn |
| `app/lib/agent/{persona,context-meter,attachments}.ts` (new) | pure helpers |
| `app/lib/agent/turn-stream.ts` | finalize `approval-requested` |
| `app/composables/useVoiceSettings.ts` | `personaVariant` |
| `app/components/agent/Persona.client.vue` (new) | `AgentPersona` |
| `app/components/agent/ContextMeter.vue` (new) | `AgentContextMeter` |
| `app/components/agent/ApprovalConfirmation.vue` (new) | inline Confirmation for a tool part |
| `app/components/agent/PromptInput.vue` (new) | `AgentPromptInput` (replaces `voice/Composer.vue`) |
| `app/components/agent/{EmptyState,ToolPart,Conversation,Toolbar,MicBand}.vue` | rewritten/updated |
| `app/pages/agent/index.vue` | two panels, voice mode on Persona |
| `app/components/voice/SettingsSlideover.vue` | Persona variant select |
| deleted | `voice/Composer.vue`, `agent/ApprovalPrompt.vue`, `agent/Avatar.client.vue`, `app/lib/avatar/**`, `app/lib/viz/**`, `scripts/bake-head.ts`, `scripts/blender-export-head.py`, `app/assets/head-points.bin`, `bake:head` script, `docs/DEPLOYMENT.md` §12 head-bake gotcha |

---

### Task 0: Spike — Persona, PromptInput, Confirmation, Context, Suggestions, Attachments (GO / NO-GO)

**Files:** CLI output under `app/components/ai-elements/{persona,prompt-input,confirmation,context,suggestion,attachments}/**` and any new `app/components/ui/**`; `nuxt.config.ts` (Nitro `publicAssets` `rive`); `package.json`, `pnpm-lock.yaml`; `app/pages/dev/elements.vue` (new sections). Artifacts: `.superpowers/sdd/2026-09-19-agent-page-rebuild/spike/`.

**Interfaces — Produces:** explicit-import Elements at `@/components/ai-elements/{persona,prompt-input,confirmation,context,suggestion,attachments}`; Rive wasm served at `/rive/<wasm file>`; a recorded wasm filename and the exact `RuntimeLoader` call that points Rive at it.

- [ ] **Step 1: Baseline.** Build with the deploy.yml command (`NODE_OPTIONS=--max-old-space-size=4096 pnpm build` — confirm against `.github/workflows/deploy.yml`) and record `find .output/public/_nuxt -name '*.js' | wc -l` and the per-file gzip total (`find .output/public/_nuxt -name '*.js' -exec gzip -c {} \; | wc -c`) to `spike/bundle-before.txt`.
- [ ] **Step 2: Install.**
```bash
pnpm dlx shadcn-vue@latest add --yes \
  https://registry.ai-elements-vue.com/persona.json \
  https://registry.ai-elements-vue.com/prompt-input.json \
  https://registry.ai-elements-vue.com/confirmation.json \
  https://registry.ai-elements-vue.com/context.json \
  https://registry.ai-elements-vue.com/suggestion.json \
  https://registry.ai-elements-vue.com/attachments.json
```
  Then: `git checkout app/assets/css/main.css` (discard any CLI CSS injection — the bridge exists); `grep -rn "@repo/" app/components` must be empty (rewrite as in cycle 64 if not); `grep -rn -E "bg-secondary\b" app/components/ai-elements app/components/ui` → replace each with `bg-elevated` (record each); if `tokenlens` was added to package.json, remove it and patch the vendored Context files that import it (`ContextContentFooter.vue`, `ContextInputUsage.vue`, `ContextOutputUsage.vue`, `ContextReasoningUsage.vue`, `ContextCacheUsage.vue`) so they render token counts without cost (drop the `getUsage` import and the cost text); `pnpm why reka-ui` must show one copy (pin to Nuxt UI's as in cycle 64 if not).
- [ ] **Step 3: Serve Rive's wasm from our origin.** Find the wasm in `node_modules/@rive-app/webgl2/` (e.g. `rive.wasm`). In `nuxt.config.ts`, next to the VAD dirs, add `const riveAssetDir = dirname(require_.resolve('@rive-app/webgl2/package.json'))` and a Nitro `publicAssets` entry `{ baseURL: 'rive', dir: riveAssetDir, maxAge: 60 * 60 * 24 * 30 }`. In the vendored `persona/Persona.vue`, before `new Rive(...)`, point the runtime at our copy using the runtime's API (e.g. `RuntimeLoader.setWasmUrl('/rive/rive.wasm')` imported from `@rive-app/webgl2` — confirm the export name and file name in the package; record them).
- [ ] **Step 4: Fixture.** Add to `app/pages/dev/elements.vue` a "Persona" section: a `<ClientOnly>` Persona with a state select (idle/listening/thinking/speaking/asleep) and a variant select (six variants), plus a second Persona instance given a deliberately bogus source (temporarily patch a `sources` entry in a local copy, or pass a prop the component supports) to prove `loadError` fires; a Context (`usedTokens=48000 maxTokens=128000` with trigger/content/header/body); a Suggestions row; a PromptInput (textarea + footer tools + submit) whose submit logs the payload; a Confirmation block in `approval-requested` state.
- [ ] **Step 5: Gates.**
  1. `pnpm typecheck` 0; `pnpm test` green.
  2. Browser (`/dev/elements`, light + dark): Persona animates in every state and variant; the wasm request goes to `/rive/...` (not unpkg/jsdelivr — check with `playwright-cli` network/console output or `performance.getEntriesByType('resource')`); the `.riv` loads from the Vercel host with no CSP/console error; the bogus instance emits `loadError`. Context, Suggestions, PromptInput and Confirmation render legibly in both themes. Screenshot + Read each.
  3. Build at 4096 MB passes; record `spike/bundle-after.txt` (count + gzip) and peak RSS (`/usr/bin/time -l`).
- [ ] **Step 6: Decide.** Write `spike/REPORT.md` (or report it in full in your final message if file writes are refused). **If Persona cannot load its wasm from our origin, or the 4096 MB build fails: STOP the cycle — do not commit — report BLOCKED with evidence.**
- [ ] **Step 7: Commit** — `feat(agent-ui): install Persona, PromptInput, Confirmation, Context, Suggestions and Attachments; serve Rive's wasm locally`.

---

### Task 1: `ModelDef.contextWindow`

**Files:** Modify `server/lib/ai/registry/types.ts`, `schema.ts`, `resolve.ts`; `app/composables/useAiConfig.ts`; `app/components/settings/ModelForm.vue`. Test: `server/lib/ai/registry/schema.test.ts` (create or extend the existing registry schema test — `ls server/lib/ai/registry/*.test.ts test/*registry*` to find it).

**Interfaces — Produces:** `ModelDef.contextWindow: number | null`; `ResolvedModel.contextWindow: number | null`; `DraftModel.contextWindow: number | null`.

- [ ] **Step 1: Failing test.**
```ts
import { describe, it, expect } from 'vitest'
import { parseConfig } from './schema'

const base = {
  version: 1,
  providers: [{ id: 'p', name: 'P', kind: 'openai-compatible', baseURL: 'http://x/v1', apiKeyEnc: null }],
  models: [{ id: 'm', providerId: 'p', modelId: 'qwen', label: 'Q', dim: null }],
  assignments: { reasoning: ['m'], bulk: [], embeddings: [], vision: [], stt: [], tts: [], rerank: [] }
}

describe('ModelDef.contextWindow', () => {
  it('defaults to null for docs written before the field existed', () => {
    expect(parseConfig(base).models[0]!.contextWindow).toBeNull()
  })
  it('accepts a positive integer', () => {
    const doc = { ...base, models: [{ ...base.models[0], contextWindow: 131072 }] }
    expect(parseConfig(doc).models[0]!.contextWindow).toBe(131072)
  })
  it('rejects zero, negatives and fractions', () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => parseConfig({ ...base, models: [{ ...base.models[0], contextWindow: bad }] })).toThrow()
    }
  })
})
```
  (Adjust `assignments` keys to the actual `USAGES` list in `types.ts` if it differs.)
- [ ] **Step 2: Run — FAIL** (`contextWindow` is stripped/undefined).
- [ ] **Step 3: Implement.** `types.ts`: `ModelDef.contextWindow: number | null` with a comment (`// max input tokens; null = unknown (the /agent context meter then shows a count only)`), and the same on `ResolvedModel`. `schema.ts` modelSchema: `contextWindow: z.number().int().positive().nullable().default(null)`. `resolve.ts` `resolveChainFrom`: copy `contextWindow: m.contextWindow ?? null` into the resolved model. `useAiConfig.ts`: `DraftModel.contextWindow: number | null`, `addModel` initializes it to `null` (and wherever drafts are built from the server doc, default missing to `null`). `ModelForm.vue`: a `UFormField label="Context window (tokens)"` with a numeric `UInput` (type number, min 1, placeholder "unknown") bound through a writable computed that maps `''`/`0` → `null` and a positive integer → the number.
- [ ] **Step 4: Run — PASS**; `pnpm typecheck`. Browser: `/settings/models` shows the field; saving a value persists (reload shows it).
- [ ] **Step 5: Commit** — `feat(ai-config): models carry an optional context window`.

---

### Task 2: Context accounting — `contextTokens` and `modelDefId` on usage

**Files:** Modify `server/lib/agent/model.ts`, `server/lib/agent/run.ts`, `shared/types/conversation.ts`, `server/lib/voice/orchestrator.ts`, `server/lib/voice/ui-stream.ts`, `server/api/voice/ws.ts`. Test: `server/lib/agent/run-usage-context.test.ts` (new); extend `server/lib/voice/ui-stream.test.ts`.

**Interfaces:**
- `model.ts`: `export async function reasoningChain(modelDefId?: string | null): Promise<{ model: LanguageModel; modelDefId: string }[]>`; `reasoningModels` becomes `(await reasoningChain(id)).map(c => c.model)`.
- `RunDeps.chain?: { model: unknown; modelDefId: string }[]` (tests only; used when present instead of `reasoningChain`).
- `AgentEvent` usage: `{ type: 'usage'; inputTokens?; outputTokens?; totalTokens?; contextTokens?: number; modelDefId?: string }`.
- `MessageUsage` gains `contextTokens?: number; modelDefId?: string`.
- VoiceEvent `usage` gains the same two optional fields.

- [ ] **Step 1: Failing test** — `server/lib/agent/run-usage-context.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { runAgent, type AgentEvent } from './run'

function stream(parts: unknown[]) {
  return { fullStream: (async function* () { for (const p of parts) yield p })() }
}
async function usageOf(parts: unknown[], deps: Record<string, unknown> = {}) {
  const events: AgentEvent[] = []
  for await (const e of runAgent([{ role: 'user', content: 'hi' }], { signal: new AbortController().signal },
    { streamText: vi.fn(() => stream(parts)) as never, tools: [], buildSystemPrompt: async () => 's', ...deps })) events.push(e)
  return events.filter(e => e.type === 'usage')
}

describe('runAgent context accounting', () => {
  it('contextTokens is the LAST step\'s input + output, not the multi-step total', async () => {
    const u = await usageOf([
      { type: 'finish-step', usage: { inputTokens: 100, outputTokens: 10 } },
      { type: 'text-delta', id: 't', delta: 'ok' },
      { type: 'finish-step', usage: { inputTokens: 150, outputTokens: 20 } },
      { type: 'finish', totalUsage: { inputTokens: 250, outputTokens: 30, totalTokens: 280 } }
    ])
    expect(u).toEqual([{ type: 'usage', inputTokens: 250, outputTokens: 30, totalTokens: 280, contextTokens: 170 }])
  })

  it('omits contextTokens when no step reported usage', async () => {
    const u = await usageOf([{ type: 'text-delta', id: 't', delta: 'ok' }, { type: 'finish', totalUsage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } }])
    expect(u[0]).not.toHaveProperty('contextTokens')
  })

  it('stamps the modelDefId of the model that produced the stream', async () => {
    const u = await usageOf(
      [{ type: 'finish-step', usage: { inputTokens: 1, outputTokens: 1 } }, { type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }],
      { chain: [{ model: {}, modelDefId: 'haiku-def' }] }
    )
    expect(u[0]).toMatchObject({ modelDefId: 'haiku-def', contextTokens: 2 })
  })
})
```
  Extend `ui-stream.test.ts`:
```ts
  it('usage metadata carries contextTokens + modelDefId and never undefined keys', async () => {
    const { message } = await assemble(encodeTurn([text('x'), { type: 'usage', inputTokens: 5, totalTokens: 9, contextTokens: 7, modelDefId: 'm1' }]))
    expect(message.metadata?.usage).toEqual({ inputTokens: 5, totalTokens: 9, contextTokens: 7, modelDefId: 'm1' })
    expect(Object.keys(message.metadata!.usage!)).not.toContain('outputTokens')
  })
```
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
  - `model.ts`: add `reasoningChain` (`reorderChain(await resolveChain('reasoning'), modelDefId).map(m => ({ model: languageModel(m), modelDefId: m.modelDefId }))`); rewrite `reasoningModels` on top of it.
  - `run.ts`: replace `const models = deps.streamText ? [undefined as never] : await reasoningModels(ctx.modelDefId)` with
    `const chain = deps.chain ?? (deps.streamText ? [{ model: undefined as never, modelDefId: undefined as string | undefined }] : await reasoningChain(ctx.modelDefId))`; iterate `chain[i].model`; keep `chosenId = chain[i].modelDefId` next to `chosen`. In both drain loops keep `let lastStep: { inputTokens?: number; outputTokens?: number } | null = null`; on a part with `type === 'finish-step'` set `lastStep = part.usage`; when `partToUsageEvent(part)` returns an event, yield `withContext(ev, lastStep, chosenId)` where
```ts
/** The context in use after this call = the LAST step's prompt + completion (the multi-step
 *  totals double-count history across steps). Undefined parts are omitted, not zeroed. */
function withContext(ev: Extract<AgentEvent, { type: 'usage' }>, lastStep: { inputTokens?: unknown; outputTokens?: unknown } | null, modelDefId: string | undefined) {
  const out: Extract<AgentEvent, { type: 'usage' }> = { ...ev }
  const i = typeof lastStep?.inputTokens === 'number' ? lastStep.inputTokens : undefined
  const o = typeof lastStep?.outputTokens === 'number' ? lastStep.outputTokens : undefined
  if (i !== undefined || o !== undefined) out.contextTokens = (i ?? 0) + (o ?? 0)
  if (modelDefId) out.modelDefId = modelDefId
  return out
}
```
    Also make `partToUsageEvent` omit undefined keys (build the object only from defined numbers) so the first test's `toEqual` holds.
  - `shared/types/conversation.ts` `MessageUsage`: add `contextTokens?: number` and `modelDefId?: string` with a one-line comment each.
  - `orchestrator.ts`: the `usage` VoiceEvent type gains `contextTokens?`/`modelDefId?`; forward them from the AgentEvent.
  - `ui-stream.ts`: build `messageMetadata.usage` from defined fields only (`inputTokens, outputTokens, totalTokens, contextTokens, modelDefId`).
  - `ws.ts`: `turnUsage` type gains the two fields and copies them (persisted via `buildTurnPersistPayload` unchanged).
- [ ] **Step 4: Run — PASS**: `pnpm vitest run server/lib/agent/ server/lib/voice/ test/run-agent.test.ts test/obs-failover.test.ts test/conversation-usage-persist.test.ts test/agent-ui-parity.test.ts`; `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(agent): usage reports the context in use and the model that answered`.

---

### Task 3: Approvals on the stream, and denied on Stop / new

**Files:** Modify `server/lib/agent/types.ts`, `server/lib/agent/ai-tools.ts`, `server/lib/voice/orchestrator.ts` (VoiceEvent only), `server/lib/voice/ui-stream.ts`, `server/api/voice/ws.ts`. Create `server/lib/voice/pending-approvals.ts` (+ test). Extend `server/lib/voice/ui-stream.test.ts`.

**Interfaces:**
- `ApprovalRequest.callId?: string` (set by ai-tools).
- VoiceEvent: `{ type: 'approval-request'; approvalId: string; callId: string; name: string }`.
- `denyPendingApprovals(pending: Map<string, { resolve: (d: { approved: boolean }) => void; timer: ReturnType<typeof setTimeout> }>): string[]` — returns the denied request ids.
- ws ConnState gains `activeTurn: TurnStream | null`.

- [ ] **Step 1: Failing tests.** `server/lib/voice/pending-approvals.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { denyPendingApprovals } from './pending-approvals'

describe('denyPendingApprovals', () => {
  it('denies every pending approval, clears its timer, empties the map, returns the ids', () => {
    vi.useFakeTimers()
    const resolved: Record<string, boolean> = {}
    const fired = vi.fn()
    const m = new Map<string, { resolve: (d: { approved: boolean }) => void; timer: ReturnType<typeof setTimeout> }>()
    for (const id of ['a', 'b']) m.set(id, { resolve: d => { resolved[id] = d.approved }, timer: setTimeout(fired, 1000) })
    expect(denyPendingApprovals(m)).toEqual(['a', 'b'])
    expect(resolved).toEqual({ a: false, b: false })
    expect(m.size).toBe(0)
    vi.advanceTimersByTime(2000)
    expect(fired).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
  it('is a no-op on an empty map', () => {
    expect(denyPendingApprovals(new Map())).toEqual([])
  })
})
```
  Extend `ui-stream.test.ts` (through the real assembler):
```ts
  it('an approval request puts the tool in approval-requested; approve → output, deny → denied', async () => {
    const start: VoiceEvent = { type: 'tool-start', callId: 'c1', name: 'exec', args: { command: 'df -h' } }
    const ask: VoiceEvent = { type: 'approval-request', approvalId: 'r1', callId: 'c1', name: 'exec' }
    const pending = await assemble(encodeTurn([start, ask]).slice(0, -2)) // no finish: still pending
    expect(pending.message.parts.find(p => p.type === 'dynamic-tool')).toMatchObject({ state: 'approval-requested', approval: { id: 'r1' } })
    const ok = await assemble(encodeTurn([start, ask, { type: 'tool', callId: 'c1', name: 'exec', summary: 'ran', args: {}, result: { stdout: 'ok' } }]))
    expect(ok.message.parts.find(p => p.type === 'dynamic-tool')).toMatchObject({ state: 'output-available', approval: { id: 'r1' } })
    const no = await assemble(encodeTurn([start, ask, { type: 'tool', callId: 'c1', name: 'exec', summary: 'denied: exec', args: {}, result: { denied: true } }]))
    expect(no.message.parts.find(p => p.type === 'dynamic-tool')).toMatchObject({ state: 'output-denied' })
  })
  it('an approval request for a call never opened opens it first', async () => {
    const { message } = await assemble(encodeTurn([{ type: 'approval-request', approvalId: 'r9', callId: 'c9', name: 'exec' }]).slice(0, -2))
    expect(message.parts.find(p => p.type === 'dynamic-tool')).toMatchObject({ toolCallId: 'c9', toolName: 'exec', state: 'approval-requested' })
  })
```
  (`encodeTurn` ends with `finish-step` + `finish`; `.slice(0, -2)` drops them so the turn stays open. If the helper's shape differs, build the chunks directly.)
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
  - `types.ts`: `ApprovalRequest` gains `callId?: string // the SDK toolCallId — lets the UI render the approval on that tool part`.
  - `ai-tools.ts`: `ctx.requestApproval({ ...approvalRequestFor(t, input), callId })` (use `callCtx`).
  - `orchestrator.ts`: add the VoiceEvent member (no orchestrator logic — ws.ts emits it straight into the turn stream).
  - `ui-stream.ts` encoder, new case:
```ts
        case 'approval-request': {
          const out = close()
          if (!started.has(e.callId)) out.push(...input(e.callId, e.name, {}))
          out.push({ type: 'tool-approval-request', approvalId: e.approvalId, toolCallId: e.callId })
          return out
        }
```
  - `pending-approvals.ts`:
```ts
// Resolve every pending exec approval as DENIED and forget it. Used when the turn that asked
// is abandoned — a new turn, a Stop / barge-in (`interrupt`), or a new conversation — so a
// tool never waits out its 120 s timeout on a question nobody can see anymore.
export function denyPendingApprovals(pending: Map<string, { resolve: (d: { approved: boolean }) => void; timer: ReturnType<typeof setTimeout> }>): string[] {
  const ids = [...pending.keys()]
  for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ approved: false }) }
  pending.clear()
  return ids
}
```
  - `ws.ts`: `ConnState.activeTurn: ReturnType<typeof createTurnStream> | null` (init `null` in `open`). In `run()`, after creating `ts`: `s.activeTurn = ts`; in a `finally` (wrap the existing try/catch): `if (s.activeTurn === ts) s.activeTurn = null`. In `requestApproval`, right after sending the `approval` frame: `if (req.callId) s.activeTurn?.emit({ type: 'approval-request', approvalId: requestId, callId: req.callId, name: req.tool })`. Add a helper `const denyAll = () => { for (const id of denyPendingApprovals(s.pendingApprovals)) peer.send(JSON.stringify({ type: 'approval-resolved', requestId: id })) }` and use it: in `interrupt` (`s.ac?.abort(); denyAll(); return`), in `new` (`s.ac?.abort(); denyAll(); s.history = []; s.conversationId = null; return`), in the new-turn path (replacing the inline loop), and in `close` (replacing the inline loop; sending on a closing peer is harmless — wrap in try/catch or skip the send there).
- [ ] **Step 4: Run — PASS**: `pnpm vitest run server/lib/voice/ server/lib/agent/ test/`; `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(agent): exec approvals ride the message stream and die with their turn`.

---

### Task 4: Client pure helpers and settings

**Files:** Create `app/lib/agent/persona.ts`, `app/lib/agent/context-meter.ts`, `app/lib/agent/attachments.ts` (+ tests). Modify `app/lib/agent/turn-stream.ts` (+ test), `app/composables/useVoiceSettings.ts` (+ test).

**Interfaces:**
```ts
// persona.ts
export const PERSONA_VARIANTS = ['obsidian', 'mana', 'opal', 'halo', 'glint', 'command'] as const
export type PersonaVariant = typeof PERSONA_VARIANTS[number]
export type PersonaState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'asleep'
export function personaState(state: VoiceState, connected: boolean): PersonaState
export function personaVariant(v: unknown): PersonaVariant   // unknown → 'obsidian'
// context-meter.ts
export interface ContextMeterData { usedTokens: number; maxTokens: number | null; modelDefId: string | null }
export function contextMeterData(messages: AgentUIMessage[], models: { id: string; contextWindow: number | null }[], fallbackModelIds: (string | null | undefined)[]): ContextMeterData | null
// attachments.ts
export const ATTACHMENT_ACCEPT: string            // 'image/*,text/*,application/pdf,application/json,application/xml,application/csv'
export const MAX_ATTACHMENTS = 4
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export function attachmentErrorToast(code: string): { title: string; description: string }
export async function uploadAttachment(file: File, post: <T>(url: string, body: FormData) => Promise<T>): Promise<AttachmentRef>
```
`useVoiceSettings`: `VoiceUserSettings.personaVariant: PersonaVariant` (default `'obsidian'`; `migrateVoiceSettings` normalizes via `personaVariant()`).

- [ ] **Step 1: Failing tests.**
  `app/lib/agent/persona.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { personaState, personaVariant } from './persona'

describe('personaState', () => {
  it('maps voice states onto the five Persona states', () => {
    expect(personaState('idle', true)).toBe('idle')
    expect(personaState('listening', true)).toBe('listening')
    for (const s of ['thinking', 'tool', 'typing'] as const) expect(personaState(s, true)).toBe('thinking')
    expect(personaState('speaking', true)).toBe('speaking')
    expect(personaState('connecting', true)).toBe('asleep')
    expect(personaState('speaking', false)).toBe('asleep')
  })
})
describe('personaVariant', () => {
  it('passes known variants, defaults everything else to obsidian', () => {
    expect(personaVariant('halo')).toBe('halo')
    expect(personaVariant('nope')).toBe('obsidian')
    expect(personaVariant(undefined)).toBe('obsidian')
  })
})
```
  `app/lib/agent/context-meter.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { contextMeterData } from './context-meter'
import type { AgentUIMessage } from '~~/shared/types/agent-ui'

const a = (id: string, usage?: object): AgentUIMessage => ({ id, role: 'assistant', parts: [], metadata: usage ? { usage } : {} })
const models = [{ id: 'haiku', contextWindow: 200000 }, { id: 'qwen', contextWindow: null }]

describe('contextMeterData', () => {
  it('uses the latest assistant message that reported contextTokens, and its model\'s window', () => {
    const d = contextMeterData([a('1', { contextTokens: 10, modelDefId: 'qwen' }), a('2', { contextTokens: 42000, modelDefId: 'haiku' })], models, [])
    expect(d).toEqual({ usedTokens: 42000, maxTokens: 200000, modelDefId: 'haiku' })
  })
  it('falls back to the selected / chain-head model when the message has no modelDefId', () => {
    expect(contextMeterData([a('1', { contextTokens: 5 })], models, [null, 'haiku'])).toEqual({ usedTokens: 5, maxTokens: 200000, modelDefId: 'haiku' })
  })
  it('unknown window → maxTokens null', () => {
    expect(contextMeterData([a('1', { contextTokens: 5, modelDefId: 'qwen' })], models, [])!.maxTokens).toBeNull()
  })
  it('no usage yet (or only legacy usage without contextTokens) → null', () => {
    expect(contextMeterData([], models, [])).toBeNull()
    expect(contextMeterData([a('1', { totalTokens: 99 })], models, [])).toBeNull()
  })
})
```
  `app/lib/agent/attachments.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { uploadAttachment, attachmentErrorToast, ATTACHMENT_ACCEPT, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from './attachments'

describe('attachments', () => {
  it('keeps today\'s limits', () => {
    expect(MAX_ATTACHMENTS).toBe(4)
    expect(MAX_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024)
    expect(ATTACHMENT_ACCEPT.split(',')).toEqual(['image/*', 'text/*', 'application/pdf', 'application/json', 'application/xml', 'application/csv'])
  })
  it('uploads images to /api/upload and other files to /api/agent/files', async () => {
    const post = vi.fn(async (url: string) => url === '/api/upload' ? { id: 'img1' } : { id: 'f1', kind: 'file', mime: 'application/pdf', name: 'srv.pdf' })
    expect(await uploadAttachment(new File(['x'], 'a.png', { type: 'image/png' }), post as never)).toEqual({ id: 'img1', kind: 'image', mime: 'image/png', name: 'a.png' })
    expect(await uploadAttachment(new File(['x'], 'a.pdf', { type: 'application/pdf' }), post as never)).toEqual({ id: 'f1', kind: 'file', mime: 'application/pdf', name: 'srv.pdf' })
    expect(post.mock.calls.map(c => c[0])).toEqual(['/api/upload', '/api/agent/files'])
  })
  it('maps PromptInput error codes to today\'s toast copy', () => {
    expect(attachmentErrorToast('accept').title).toBe('Unsupported file type')
    expect(attachmentErrorToast('max_file_size').title).toBe('File too large')
    expect(attachmentErrorToast('max_files').title).toBe('Too many attachments')
    expect(attachmentErrorToast('submit_error').title).toBe('Upload failed')
  })
})
```
  Append to `app/lib/agent/turn-stream.test.ts` (inside the `finalizeMessage` describe):
```ts
  it('a pending approval ends as Stopped', () => {
    const m: AgentUIMessage = { id: 'a', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'exec', toolCallId: 'c', state: 'approval-requested', input: {}, approval: { id: 'r1' } }] }
    expect(finalizeMessage(m, { interrupted: true }).parts[0]).toMatchObject({ state: 'output-error', errorText: 'Stopped' })
  })
```
  Append to `app/composables/useVoiceSettings.test.ts`:
```ts
  it('personaVariant defaults to obsidian and unknown values are normalized', () => {
    expect(migrateVoiceSettings({}).personaVariant).toBe('obsidian')
    expect(migrateVoiceSettings({ personaVariant: 'glint' } as never).personaVariant).toBe('glint')
    expect(migrateVoiceSettings({ personaVariant: 'bogus' } as never).personaVariant).toBe('obsidian')
  })
```
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
  - `persona.ts`: as the interface; `import type { VoiceState } from '~/composables/useVoice'`.
  - `context-meter.ts`: walk `messages` from the end; take the first assistant message whose `metadata.usage.contextTokens` is a number; `modelDefId = usage.modelDefId ?? first non-empty of fallbackModelIds ?? null`; `maxTokens = models.find(m => m.id === modelDefId)?.contextWindow ?? null`.
  - `attachments.ts`: move the constants from `voice/Composer.vue`; `uploadAttachment` reproduces `uploadOne` exactly (image → `/api/upload` → `{ id, kind: 'image', mime: file.type, name: file.name }`; else `/api/agent/files` → `{ id, kind: 'file', mime: r.mime, name: r.name ?? file.name }`) using the injected `post(url, form)`; `attachmentErrorToast` returns today's titles/descriptions ("Unsupported file type" / "Only images, PDFs, and text files are supported.", "File too large" / "Attachments are limited to 20 MB.", "Too many attachments" / "Maximum 4 attachments per message.", "Upload failed" / "Could not upload an attachment. Try again." for anything else).
  - `turn-stream.ts` `finalizeMessage`: include `p.state === 'approval-requested'` in the dangling-tool condition.
  - `useVoiceSettings.ts`: add the field + default + normalize in `migrateVoiceSettings`.
- [ ] **Step 4: Run — PASS**: `pnpm vitest run app/`; `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(agent-ui): persona state, context-meter data and attachment upload as pure helpers`.

---

### Task 5: `AgentPersona`, `AgentContextMeter`, inline approval, empty state (built on the fixture)

**Files:** Create `app/components/agent/Persona.client.vue`, `ContextMeter.vue`, `ApprovalConfirmation.vue`. Modify `app/components/agent/ToolPart.vue`, `Conversation.vue`, `EmptyState.vue`, `MicBand.vue`; `app/pages/dev/elements.vue`.

**Interfaces:**
- `<AgentPersona :state="VoiceState" :connected="boolean" size="hero|inline|full" />` — reads `useVoiceSettings().settings.personaVariant`.
- `<AgentContextMeter :data="ContextMeterData | null" />` — renders nothing for `null`.
- `<AgentApprovalConfirmation :part :details="{ requestId, tool, command, proposedPattern } | null" @approve="(requestId, { remember, pattern })" @deny="(requestId)" />`.
- `AgentConversation` gains props `approval` (the pending details or null), `state: VoiceState` and `connected: boolean` (forwarded to `AgentEmptyState` for the hero Persona), and emits `approve`/`deny` (passed through to ToolPart).
- `AgentEmptyState` gains props `state`, `connected` (for the hero Persona); still emits `pick`.

- [ ] **Step 1: Components.** Use the vendored APIs installed in Task 0 (read each component's props first; adapt minimally if they differ from below and record it).
  - `Persona.client.vue`: wraps Elements `Persona` with `:state="personaState(state, connected)"` and `:variant="personaVariant(settings.personaVariant)"`; size classes: hero `size-40`, inline `size-7`, full `size-72 sm:size-96`; on `loadError` switch to a fallback `<div>` (rounded-full, `bg-primary/20`, a CSS pulse whose speed follows the mapped state — e.g. `animate-pulse` for thinking/speaking, static for idle/asleep) and `console.warn('[persona] falling back:', err)` once per page load.
  - `ContextMeter.vue`: Elements `Context` with `:used-tokens="data.usedTokens" :max-tokens="data.maxTokens ?? 0"`; trigger + content (header + body input/output rows, no cost). When `maxTokens` is null show the trigger as a plain token count (e.g. `1.8k tok`, reuse `tokenLabel` from `~/lib/agent/render`) with a tooltip "Context window unknown — set it in Settings → Models".
  - `ApprovalConfirmation.vue`: Elements `Confirmation` (`:approval="part.approval" :state="part.state"`) → `ConfirmationTitle` ("Run this?" / "Approve `<toolName>`?"), `ConfirmationRequest` holding the command `<pre>` and today's remember checkbox + pattern `UInput` (pattern initialised from `details.proposedPattern`, reset when `details.requestId` changes), `ConfirmationActions` with Deny (outline) / Approve. If `details` is null, show the input JSON instead of the command and hide the remember row; Approve/Deny use `part.approval.id`.
  - `ToolPart.vue`: render `<AgentApprovalConfirmation>` below the header when `part.state === 'approval-requested'`; forward `approve`/`deny`.
  - `Conversation.vue`: new props/emits as above; pass `approval` + handlers to each `AgentToolPart`, and `state`/`connected` to `AgentEmptyState`.
  - `EmptyState.vue`: hero `AgentPersona` above the greeting; the four starters rendered with Elements `Suggestions` / `Suggestion` (click → `emit('pick', text)`).
  - `MicBand.vue`: replace the `PALETTE` import with local constants holding the same colours (`ACTIVE = hex 0x22d3ee`, `IDLE = hex 0x1e3a5f`, `THRESHOLD = hex 0xf59e0b` as `[r,g,b]` 0..1 tuples).
- [ ] **Step 2: Fixture.** In `/dev/elements`: an `AgentPersona` row with a state select + `connected` toggle; `AgentContextMeter` with known window, unknown window, and `null`; a fixture message whose exec tool part is `approval-requested` (with `approval: { id: 'r1' }`) and a `details` object, wired to log approve/deny; the new `AgentEmptyState`.
- [ ] **Step 3: Browser-validate** (light + dark, screenshots Read): Persona sizes and states; fallback when forced (use Task 0's bogus instance); meter trigger + hover content for the three cases; inline confirmation — edit the pattern, tick remember, Approve logs `('r1', { remember: true, pattern })`, Deny logs `('r1')`; the minimal (no details) variant; empty state suggestions click → logs.
- [ ] **Step 4:** `pnpm typecheck`; `pnpm test`.
- [ ] **Step 5: Commit** — `feat(agent-ui): Persona, context meter, inline approval and the new empty state`.

---

### Task 6: `AgentPromptInput` — the Elements composer

**Files:** Create `app/components/agent/PromptInput.vue`. Modify `app/pages/dev/elements.vue`.

**Interfaces:**
```ts
defineProps<{
  sendText: (t: string, speak?: boolean, attachments?: AttachmentRef[]) => boolean | Promise<boolean>
  busy: boolean
  micOn: boolean
  state: VoiceState
  connected: boolean
  showPersona: boolean              // inline Persona in the footer (false in the empty state / voice mode)
  contextMeter: ContextMeterData | null
  initialText?: string              // ?q= hand-off
  autoSend?: boolean
  prefill?: string                  // starter click
}>()
const speak = defineModel<boolean>('speak', { required: true })
const model = defineModel<string>('model', { required: true })   // same '__default__' sentinel as the old Toolbar
defineEmits<{ stop: []; toggleMic: [] }>()
```

- [ ] **Step 1: Build it** on Elements PromptInput in **provider mode**: call `usePromptInputProvider({ accept: ATTACHMENT_ACCEPT, maxFiles: MAX_ATTACHMENTS, maxFileSize: MAX_ATTACHMENT_BYTES, onSubmit, onError })` in setup (it `provide`s the context) and render `<PromptInput multiple global-drop>` inside, which inherits it. Consequences to rely on (read `prompt-input/context.ts` to confirm): `submitForm` clears the text before calling `onSubmit`, restores it if `onSubmit` throws, and only clears the files on success.
  - `onSubmit(msg)`: text = `msg.text.trim()`; files = the provider's current `files.value` items' `.file` (the `File` objects — the payload's URLs are data URLs); if neither, return; upload each with `uploadAttachment(file, (url, body) => $fetch(url, { method: 'POST', body }))` — on failure **throw** (the provider restores the text, keeps the files, and calls `onError('submit_error')`); then `await props.sendText(text, speak.value, refs)`.
  - `onError({ code })`: `toast.add({ ...attachmentErrorToast(code), color: 'error' })`.
  - Header: Elements `Attachments variant="inline"` listing the provider's `files` with preview + remove (`removeFile(id)`).
  - Body: `PromptInputTextarea` placeholder "Ask Bridget…".
  - Footer → `PromptInputTools` left: `AgentPersona size="inline"` (when `showPersona`), an attach button (`openFileDialog()`), the model `PromptInputSelect` (items built exactly like the old `AgentToolbar.modelItems`), a speak toggle (`PromptInputButton` with a volume icon, pressed state = `speak`), `AgentContextMeter`. Below `sm` the model select and context meter move into a `PromptInputActionMenu` ("…") instead.
  - Footer right: mic toggle (`PromptInputButton`, mic/mic-off icon, `emit('toggleMic')`); when `busy`, a Stop `PromptInputButton` (`type="button"`, square icon, `emit('stop')`), else `PromptInputSubmit` (disabled when there's no text and no file).
  - `?q=`: on mount and when `initialText` changes, `setTextInput(initialText)`; if `autoSend`, auto-submit at most once per distinct value (same guard as `voice/Composer.vue`'s `maybeAutoSend`) by calling `submitForm()` after `nextTick()`.
  - `prefill`: when it changes, `setTextInput(prefill)` (never sends).
- [ ] **Step 2: Fixture.** Mount `AgentPromptInput` on `/dev/elements` with a fake `sendText` that logs `(text, speak, attachments)` and resolves; `busy`/`micOn` toggles; a sample `contextMeter`.
- [ ] **Step 3: Browser-validate** (light + dark; 1440 and 375 px): type + Enter sends and clears; Shift+Enter newline; attach via button (image + PDF) shows the tray, remove works, send logs refs (real uploads hit dev `/api/upload` and `/api/agent/files`); paste an image (write a small PNG to the clipboard via `playwright-cli` or document if the CLI can't) and drop a file; an oversize/unsupported file toasts; `busy` shows Stop and it emits `stop`; mic toggles; the model select switches value; at 375 px the "…" menu holds model + meter and nothing overflows; `initialText` + `autoSend` sends once; `prefill` fills without sending.
- [ ] **Step 4:** `pnpm typecheck`; `pnpm test`.
- [ ] **Step 5: Commit** — `feat(agent-ui): the Elements composer — attachments, model, speak, context, mic, send/stop`.

---

### Task 7: The page — two panels, voice mode on Persona, variant picker

**Files:** Modify `app/pages/agent/index.vue`, `app/components/agent/Toolbar.vue`, `app/components/voice/SettingsSlideover.vue`.

- [ ] **Step 1: Page.**
  - Remove the `agent-bridget` panel, `showBridgetAvatar`, `isLgUp` (if now unused), the `AgentAvatar` mounts and the `AgentApprovalPrompt` block.
  - Conversation panel body: `AgentConversation` (pass `:approval="voice.pendingApproval.value"`, `@approve="(id, o) => voice.sendApproval(id, true, o)"`, `@deny="id => voice.sendApproval(id, false)"`), then — when `micOn` — `AgentMicBand`, then `AgentPromptInput` (props from the page state: `sendText=voice.sendText`, `busy`, `micOn`, `state`, `connected`, `:show-persona="voice.messages.value.length > 0 && !fullBleed"`, `:context-meter="contextMeter"`, `initialText`/`autoSend`/`prefill`, `v-model:speak`, `v-model:model="selectedModel"`, `@stop`, `@toggle-mic`).
  - `contextMeter = computed(() => contextMeterData(voice.messages.value, aiDraft.value.models, [agentModel.value || null, aiDraft.value.assignments.reasoning?.[0]]))`.
  - Pass `:state="voice.state.value" :connected="voice.connected.value"` to `AgentConversation` so the empty state's hero Persona animates; the hero and the inline Persona are never mounted together (inline requires messages).
  - Full-bleed voice mode: replace `AgentAvatar` with `<AgentPersona size="full" :state :connected />`, keep the caption (`MessageResponse`/`MdView` as today) and `AgentMicBand`; the inline Persona is hidden while it's open (`showPersona` includes `!fullBleed`).
- [ ] **Step 2: Toolbar.** Remove the speak `USwitch` and model `USelectMenu` (and `modelItems`/`useAiConfig` if unused); keep title, threads button, voice-mode button, the settings slot. Drop the `speak`/`model` models from its props and the page binding.
- [ ] **Step 3: SettingsSlideover.** Add a `UFormField label="Persona"` with a `USelect` over `PERSONA_VARIANTS` bound to `settings.personaVariant` (labels capitalized), after "Voice replies".
- [ ] **Step 4: Browser-validate `/agent`** (dev on a spare port; pick the LiteLLM model in the composer): empty state hero + suggestions (click prefills); send a message → inline Persona goes thinking → idle; a tool-using turn renders tools; voice mode opens with the big Persona + caption + mic band and closes with Escape; mic on shows the band above the composer; variant picker changes the Persona live; threads rail + mobile slideover; 375 px layout; light + dark. Screenshots Read.
- [ ] **Step 5:** `pnpm typecheck`; `pnpm test`. **Commit** — `feat(agent): two-panel /agent with Persona and the Elements composer`.

---

### Task 8: Retire the particle head and the viz channel

**Files:** Delete `app/components/agent/Avatar.client.vue`, `app/components/agent/ApprovalPrompt.vue`, `app/components/voice/Composer.vue`, `app/lib/avatar/**`, `app/lib/viz/**`, `scripts/bake-head.ts`, `scripts/blender-export-head.py`, `app/assets/head-points.bin`. Modify `package.json` (remove `bake:head`), `app/composables/useVoice.ts`, `app/lib/voice/messages.ts` (+ `app/lib/voice/messages.test.ts`, `test/voice-messages.test.ts`), `docs/DEPLOYMENT.md`.

- [ ] **Step 1: Tests first.** In both messages test files, remove every `events` expectation (the `events` field is going away) — e.g. the user-message case becomes `expect(mapServerMessage(frame as never, false)).toEqual({ messageFrame: frame })`, the error case asserts only `error`. Run → FAIL.
- [ ] **Step 2: Implement.** `messages.ts`: drop `events` from `MsgEffect` and every return, and the `VizEvent` import. `useVoice.ts`: drop `createEmitter`, `VizEvent`, `events`, every `events.emit(...)`, and `onVizEvent` from the return (keep `micAnalyser`/`outAnalyser`, `speechProb`). Delete the files listed above; remove the `bake:head` script; remove `DEPLOYMENT.md` §12's head-bake / `head-points.bin` gotcha (keep the rest of §12).
- [ ] **Step 3: Verify nothing references them:**
```bash
grep -rn -E "lib/viz|lib/avatar|AgentAvatar|AgentApprovalPrompt|VoiceComposer|onVizEvent|VizEvent|head-points|bake-head|bake:head|createEmitter" app server shared scripts test package.json nuxt.config.ts docs/DEPLOYMENT.md
```
  Expected: empty. `three` must still be imported by `app/lib/galaxy/**` (do not remove the dependency).
- [ ] **Step 4: Gates.** `pnpm typecheck`; `pnpm test`; the 4096 MB build passes — record client JS count + gzip vs Task 0's before/after (the agent route should shrink by the viz/avatar code).
- [ ] **Step 5: Commit** — `chore(agent): retire the particle head, the bake pipeline and the viz event channel`.

---

### Task 9: Live validation, docs, handover

**Files:** `docs/wiki/agent.md`, `docs/wiki/voice-agent.md`, `docs/handovers/2026-09-19-agent-page-rebuild.md` (new), `docs/superpowers/plans/00-roadmap.md`, `docs/BACKLOG.md`. (MyMind mirroring and task updates are done by the controller.)

- [ ] **Step 1: Live validation on `/agent`** (LiteLLM model selected; dev on a spare port; light + dark; 1440 + 375 px). Each item: drive it, screenshot, Read, PASS/FAIL:
  1. Empty state: hero Persona animates; a suggestion prefills the composer.
  2. A typed turn: inline Persona thinking → idle; reply renders; the context meter shows usage (set a context window on the model in `/settings/models` first → the ring shows a %).
  3. An exec approval inline ("Check disk usage on the app box"): Confirmation on the tool part; Deny → tool Denied; ask again, Approve with "remember" + edited pattern → tool runs; the allow-list entry exists (settings or `fetch`).
  4. Stop while an approval is pending → tool "Stopped", the confirmation disappears, the next message runs immediately (no 120 s stall).
  5. New conversation while a turn runs → the old turn doesn't appear in the new thread.
  6. Speak mode: Persona speaking during playback.
  7. Voice mode: full Persona + caption + mic band; Escape exits.
  8. Mic on: band above the composer.
  9. Attachments: image + PDF via button, paste, drop → render in the user message; the agent can read the image.
  10. `?q=` from Home's "Ask the brain" auto-sends once.
  11. Resume an older thread (meter hidden until the next turn) and a cycle-65 thread (meter shown).
  12. Variant picker switches the Persona; Persona fallback (block the Vercel host — e.g. `playwright-cli route` if available, or document the fixture-page proof from Task 0).
  Fix any defect test-first where unit-testable; commit each fix separately.
- [ ] **Step 2: Wiki.** `agent.md`: UI section (two panels, Persona placements, composer, inline approvals, context meter), approval protocol (`tool-approval-request`, deny-on-interrupt/new), usage `contextTokens`/`modelDefId`, `ModelDef.contextWindow`, the retired avatar. `voice-agent.md`: remove the avatar/viz sections, note Persona is state-driven and Rive's wasm path. Bump `updated:`.
- [ ] **Step 3: Handover + roadmap + backlog** — accurate frontmatter; status BUILT, NOT MERGED; the spike numbers; bundle before/after; every ledger ruling with cost-if-wrong; deferred minors; live-validation results; next_seam → cycle 66 (MyMind task `14d0074b`). Roadmap cycle-65 row; BACKLOG: close the face complaint and task `26fc248c`.
- [ ] **Step 4: Gates + commit.** `pnpm typecheck`, `pnpm test`, 4096 MB build — `docs: cycle 65 handover, wiki, roadmap and backlog`.
