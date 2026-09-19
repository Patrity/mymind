# Agent Elements Foundation (cycle 64) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `/agent` conversation streams AI SDK `UIMessage`s over the existing voice WebSocket and renders them with AI Elements Vue — tool calls with real running/done/error/denied states, inputs and outputs, and subagent steps nested inline.

**Architecture:** The server keeps `runAgent` and the voice orchestrator; a pure encoder turns the orchestrator's `VoiceEvent`s into `UIMessageChunk`s, which a per-turn "turn stream" sends as `turnId`-stamped WS frames beside the unchanged audio frames. The client feeds each turn's chunks to the SDK's own `readUIMessageStream` and renders the resulting `UIMessage[]` with AI Elements Vue (shadcn-vue, installed beside Nuxt UI through a token bridge). Resumed threads are converted on read — no migration.

**Tech Stack:** Nuxt 4, Nuxt UI 4.8, AI SDK `ai` v6 (`readUIMessageStream`, `UIMessageChunk`, `MockLanguageModelV3`), AI Elements Vue (shadcn-vue, reka-ui, `vue-stream-markdown`, `vue-stick-to-bottom`), vitest, playwright-cli.

**Spec:** [`docs/superpowers/specs/2026-09-19-agent-elements-foundation-design.md`](../specs/2026-09-19-agent-elements-foundation-design.md) — read it first; this plan argues from it.

## Global Constraints

- Package manager is **pnpm** only (`pnpm add`, `pnpm dlx`). Never npm/yarn.
- **Commit messages: no `Co-Authored-By` trailer and no model names.** Tony's global rule; it overrides any harness attribution reminder.
- Gates: `pnpm typecheck` (0 errors), `pnpm test` (all green), `pnpm build` (exit 0). `pnpm lint` is red repo-wide and is **not** a gate.
- Tests are vitest, colocated `*.test.ts` (or under `test/`). No `*.db.test.ts` in this cycle.
- UI validation uses **`playwright-cli`** (never the Playwright MCP), via the project `browser-testing` skill. Dev creds: `test@example.com` / `testpassword123`.
- Work in a **git worktree** on branch `feat/agent-elements-foundation` (parallel sessions share HEAD in the main checkout). Run the dev server on a spare port (e.g. `PORT=3217 pnpm dev`) and kill only the PID you started.
- Nuxt UI keeps the `primary`, `secondary` and `muted` Tailwind tokens. shadcn's stock theme CSS is **never** imported.
- Assistant message text stays **raw markdown**; `toSpeakable` output only ever reaches TTS.
- Aborted turns are still **not persisted** (unchanged).
- `/api/agent/chat` is **not touched**.
- A tool's args on the wire are always the **redacted** `safeArgs` (then capped); never raw tool input.

## Deviations from the spec (decided while planning — each is smaller or safer)

1. **Encoder and turn runner live in `server/lib/voice/`** (`ui-stream.ts`, `turn-stream.ts`), not `server/lib/agent/`: both consume the orchestrator's `VoiceEvent`.
2. **No separate 16 KB wire cap.** The orchestrator already caps what it persists (`ARGS_WRITE_CAP` 4096 / `WRITE_RESULT_CAP` 8192). The live tool events now carry *those same capped copies*, so what the UI shows live is byte-for-byte what a resumed thread shows, and the wire is bounded by the smaller persist caps.
3. **The envelope has no `images`.** Image embeds are already appended to the message text; showing them again in the tool output would duplicate them and break live/resume parity.
4. **Usage rides the SDK's `message-metadata` chunk**, not a `data-usage` part. Verified: later metadata replaces earlier (`usage` supersede semantics preserved) and no extra part appears in `parts`.
5. **New task: a live event channel in `runAgent`.** Verified 2026-09-19 against the real SDK: `fullStream` emits nothing while a tool's `execute` is pending, and `runAgent` only drains its tool-event queue when the next part arrives — so events a tool emits *while running* (a subagent's nested calls) arrive in one burst when it finishes. `tool-start` itself was confirmed to arrive live.
6. **`tool-output-denied` confirmed** accepted by `readUIMessageStream` from `input-available` (state `output-denied`). Data parts with the same `id` reconcile (replace); `error` chunks call `onError` without throwing and keep the partial text; an `abort` leaves an open tool at `input-available` and an unterminated text part at `streaming` — hence client-side finalization.
7. **User messages always come from the server** (`user-message` frame), as today's UX already waits for the server echo. The user message carries its `AttachmentRef[]` in `metadata.attachments` so retry can re-send them.
8. **`Composer.vue`'s `entries` prop is unused** — removed rather than migrated.

## File structure

| File | Responsibility |
|---|---|
| `shared/types/agent-ui.ts` (new) | `AgentUIMessage`, `AgentUIPart`, `AgentUIChunk`, `AgentMessageFrame`, `ToolEnvelope`, `SubagentStep`, metadata types |
| `shared/utils/agent-ui.ts` (new) | Pure helpers shared by server and client: `toolOutcome`, `toolEnvelope`, `attachmentUrl`, `attachmentToFilePart` |
| `server/lib/agent/types.ts` | `ToolStartEvent` / `ToolResultEvent` / `SubagentEvent`; `ToolContext.onNestedEvent` |
| `server/lib/agent/ai-tools.ts` | `callId` on tool-start; per-call context whose `onNestedEvent` emits `subagent-event` |
| `server/lib/agent/run.ts` | `AgentEvent` union; push-based event channel |
| `server/lib/agent/subagents.ts` | Forward nested tool events |
| `server/lib/agent/tool-history.ts` | `AgentToolRecord.steps` |
| `server/lib/voice/orchestrator.ts` | `tool-start` / enriched `tool` / `subagent` VoiceEvents; record `steps` |
| `server/lib/voice/ui-stream.ts` (new) | Pure `VoiceEvent → UIMessageChunk` encoder |
| `server/lib/voice/turn-stream.ts` (new) | Per-turn frame writer (turnId, user-message, chunk frames, finish/error/abort ordering) |
| `server/api/voice/ws.ts` | turnId counter; delegate framing to the turn stream |
| `app/lib/agent/turn-stream.ts` (new) | Client per-turn assembly, stale-turn filtering, finalization |
| `app/lib/agent/to-ui-messages.ts` (new) | Persisted DTOs → `AgentUIMessage[]` (replaces `transcript.ts`) |
| `app/lib/agent/render.ts` (new) | Pure render helpers (subagent lookup, message text, token label, tool title) |
| `app/lib/agent/retry.ts` | Retry over `AgentUIMessage[]` |
| `app/lib/voice/playback-epoch.ts` | `rejectSegment()` for stale-turn audio |
| `app/lib/voice/messages.ts` | Frame mapping (chunk / user-message / audio-begin turnId) |
| `app/composables/useVoice.ts` | `messages: Ref<AgentUIMessage[]>` |
| `app/components/agent/Conversation.vue`, `ToolPart.vue`, `SubagentSteps.vue`, `ReplyActions.vue`, `Attachment.vue` | Elements-based rendering (`ReplyActions` replaces `MessageActions`, deleted in Task 10) |
| `app/pages/agent/index.vue` | Swap transcript for `AgentConversation` |
| `app/pages/dev/elements.vue` (new, dev-only) | Spike + component fixture page |
| `app/components/ui/**`, `app/components/ai-elements/**`, `components.json`, `app/lib/utils.ts` | shadcn-vue / Elements CLI output |
| deleted | `voice/Transcript.vue`, `agent/ReasoningBlock.vue`, `agent/MessageActions.vue`, `lib/agent/transcript.ts` (+test), `composables/useTextChat.ts`, `composables/useAgentActivity.ts` |

---

### Task 0: Coexistence spike — AI Elements Vue beside Nuxt UI (GO / NO-GO gate)

**Files:**
- Create: `components.json`, `app/lib/utils.ts`, `app/components/ui/**` (CLI), `app/components/ai-elements/**` (CLI), `app/pages/dev/elements.vue`
- Modify: `nuxt.config.ts`, `app/assets/css/main.css`, `package.json`, `pnpm-lock.yaml`
- Artifacts (gitignored): `.superpowers/sdd/2026-09-19-agent-elements-foundation/spike/*`

**Interfaces:**
- Produces: importable Elements at `@/components/ai-elements/{conversation,message,tool,reasoning,chain-of-thought,shimmer,code-block}` (explicit imports only — these dirs are excluded from Nuxt auto-import); `cn()` at `@/lib/utils`; the `data-ai-elements` attribute that scopes the border base rule.

- [ ] **Step 1: Baseline screenshots and bundle size (before any change)**

```bash
mkdir -p .superpowers/sdd/2026-09-19-agent-elements-foundation/spike
pnpm build
find .output/public/_nuxt -name '*.js' -exec gzip -c {} \; | wc -c > .superpowers/sdd/2026-09-19-agent-elements-foundation/spike/bundle-before.txt
PORT=3217 pnpm dev   # background; note the PID
```

Using the `browser-testing` skill (log in at `http://localhost:3217`), for each of `/`, `/tasks`, `/documents`, `/settings`, in **light and dark** (toggle via the color-mode button, or `playwright-cli eval "() => document.documentElement.classList.toggle('dark')"`):
`playwright-cli screenshot --filename=.superpowers/sdd/2026-09-19-agent-elements-foundation/spike/before-<page>-<mode>.png`

- [ ] **Step 2: shadcn-vue config + `cn()` + auto-import exclusion**

`components.json`:

```json
{
  "$schema": "https://shadcn-vue.com/schema.json",
  "style": "new-york",
  "typescript": true,
  "tailwind": {
    "config": "",
    "css": "app/assets/css/main.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "composables": "@/composables",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib"
  },
  "iconLibrary": "lucide"
}
```

`app/lib/utils.ts`:

```ts
// shadcn-vue / AI Elements class merger. Lives in app/lib (not app/utils) so Nuxt does not
// auto-import it app-wide — the vendored components import it explicitly as `@/lib/utils`.
import type { ClassValue } from 'clsx'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

In `nuxt.config.ts`, add a top-level `components` entry (next to `css:`):

```ts
  // shadcn-vue primitives and AI Elements are vendored with barrel index.ts files and are
  // imported EXPLICITLY (`@/components/ai-elements/...`). Auto-registering them would put a
  // second `Button`/`Collapsible` family into the global component namespace beside Nuxt UI's.
  components: [
    { path: '~/components', ignore: ['ui/**', 'ai-elements/**'] }
  ],
```

- [ ] **Step 3: Install the Elements this cycle renders**

```bash
pnpm dlx shadcn-vue@latest add --yes \
  https://registry.ai-elements-vue.com/conversation.json \
  https://registry.ai-elements-vue.com/message.json \
  https://registry.ai-elements-vue.com/tool.json \
  https://registry.ai-elements-vue.com/reasoning.json \
  https://registry.ai-elements-vue.com/chain-of-thought.json \
  https://registry.ai-elements-vue.com/shimmer.json \
  https://registry.ai-elements-vue.com/code-block.json
```

Then:
- `git diff --stat` and record every added dependency in the spike notes (expected: `reka-ui`, `clsx`, `tailwind-merge`, `class-variance-authority`, `@lucide/vue`, `vue-stream-markdown`, `vue-stick-to-bottom`, `shiki`, `tw-animate-css`). If `reka-ui` was added at a version different from the one Nuxt UI resolves (`pnpm why reka-ui`), pin it to Nuxt UI's range so only one copy is installed.
- `git checkout app/assets/css/main.css` — discard whatever the CLI injected; the bridge is written by hand in Step 4.
- `grep -rn "@repo/" app/components/ai-elements app/components/ui` must print nothing. If it does: `sed -i '' 's#@repo/shadcn-vue/components/ui#@/components/ui#g; s#@repo/shadcn-vue/lib/utils#@/lib/utils#g'` over those files.

- [ ] **Step 4: The token bridge**

Append to `app/assets/css/main.css`:

```css
@import "tw-animate-css";

/* ── shadcn-vue / AI Elements bridge ──────────────────────────────────────────────
   Nuxt UI OWNS --color-primary, --color-secondary and the bg-/text-muted utilities; shadcn's
   stock theme redefines the same names with different meanings and would repaint every
   Nuxt UI component. So: never import shadcn's theme. Define only the shadcn tokens Nuxt UI
   does not own, each pointing at Nuxt UI's own variable, so both themes switch together. */
@theme inline {
  --color-background: var(--ui-bg);
  --color-foreground: var(--ui-text);
  --color-card: var(--ui-bg);
  --color-card-foreground: var(--ui-text);
  --color-popover: var(--ui-bg);
  --color-popover-foreground: var(--ui-text);
  --color-primary-foreground: var(--ui-text-inverted);
  --color-secondary-foreground: var(--ui-text-highlighted);
  --color-muted-foreground: var(--ui-text-muted);
  --color-accent: var(--ui-bg-elevated);
  --color-accent-foreground: var(--ui-text-highlighted);
  --color-destructive: var(--ui-error);
  --color-border: var(--ui-border);
  --color-input: var(--ui-border-accented);
  --color-ring: var(--ui-border-accented);
  --radius-sm: var(--ui-radius);
  --radius-md: calc(var(--ui-radius) * 1.5);
  --radius-lg: calc(var(--ui-radius) * 2);
  --radius-xl: calc(var(--ui-radius) * 3);
}

/* shadcn components use bare `border` and rely on a global `* { border-color }` base rule.
   Applying that globally would recolor every bare `border` in the app, so scope it to
   Elements roots (zero specificity — any explicit border-* utility still wins). */
@layer base {
  :where([data-ai-elements]), :where([data-ai-elements]) :where(*) {
    border-color: var(--ui-border);
  }
}
```

- [ ] **Step 5: Patch the "secondary = grey" assumption**

```bash
grep -rn -E "(bg|text|border|ring|fill|stroke)-(secondary|primary|muted)\b" app/components/ai-elements app/components/ui > .superpowers/sdd/2026-09-19-agent-elements-foundation/spike/token-usage.txt
```

For every `bg-secondary` (shadcn's grey surface; Nuxt UI's brand colour) replace it with `bg-elevated` — e.g. in `app/components/ai-elements/message/MessageContent.vue`, `group-[.is-user]:bg-secondary` → `group-[.is-user]:bg-elevated`. `bg-primary` (brand green), `bg-muted`, `text-muted-foreground` stay. Record every edit in the spike notes.

- [ ] **Step 6: Dev-only fixture page**

Pick a real image id from the dev DB: `playwright-cli eval "async () => (await (await fetch('/api/images?limit=1')).json())"` (use the first id; if the dev gallery is empty, upload one through `/gallery` first).

`app/pages/dev/elements.vue`:

```vue
<script setup lang="ts">
// Dev-only fixture for the AI Elements spike and for Task 9's component work. 404s in prod.
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'

if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: 'Not found', fatal: true })
definePageMeta({ title: 'Elements fixture' })

const IMAGE_ID = 'REPLACE_WITH_REAL_DEV_IMAGE_ID' // Step 6: a real id from /api/images
const md = [
  '## Heading', '', 'Some **bold**, `inline code`, and a [link](https://example.com).', '',
  '- one', '- two', '', '| a | b |', '|---|---|', '| 1 | 2 |', '',
  '```ts', 'const x: number = 1', '```', '',
  `![a real embed](/api/images/${IMAGE_ID}/raw)`
].join('\n')
const states = ['input-streaming', 'input-available', 'output-available', 'output-error', 'output-denied'] as const
</script>

<template>
  <div class="h-full p-4" data-ai-elements>
    <Conversation class="h-full">
      <ConversationContent>
        <Message from="user"><MessageContent>Find my notes on Orpheus</MessageContent></Message>
        <Message from="assistant">
          <MessageContent>
            <Reasoning :is-streaming="false" :default-open="false">
              <ReasoningTrigger />
              <ReasoningContent content="Looking through documents first, then the web." />
            </Reasoning>
            <Tool v-for="s in states" :key="s" :default-open="s === 'output-available'">
              <ToolHeader type="dynamic-tool" tool-name="search_docs" :state="s" />
              <ToolContent>
                <ToolInput :input="{ query: 'orpheus', limit: 5 }" />
                <ToolOutput
                  :output="s === 'output-available' ? { hits: 4 } : undefined"
                  :error-text="s === 'output-error' ? '403 from example.com' : undefined"
                />
              </ToolContent>
            </Tool>
            <ChainOfThought :default-open="true">
              <ChainOfThoughtHeader>research: orpheus TTS</ChainOfThoughtHeader>
              <ChainOfThoughtContent>
                <ChainOfThoughtStep label="web_search" description="searched (5)" status="complete" />
                <ChainOfThoughtStep label="web_fetch" description="fetching…" status="active" />
              </ChainOfThoughtContent>
            </ChainOfThought>
            <MessageResponse :content="md" />
          </MessageContent>
        </Message>
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  </div>
</template>
```

Replace `REPLACE_WITH_REAL_DEV_IMAGE_ID` with the id from above before loading the page.

- [ ] **Step 7: Run the gates**

1. `pnpm typecheck` → 0 errors. `pnpm build` → exit 0.
2. Bundle: `find .output/public/_nuxt -name '*.js' -exec gzip -c {} \; | wc -c > …/spike/bundle-after.txt`. Also compare the **entry** chunk (the largest file referenced by `.output/public/_nuxt/entry*.js` or the `<script type=module>` in `.output/public/index.html`) before/after. **Gate:** the entry chunk grows by ≤ 50 KB gz (Elements must land only in route chunks). Record the total delta.
3. No repaint: restart dev, retake every `before-*` screenshot as `after-*`, then for each pair `magick compare -metric AE before.png after.png diff.png` (ImageMagick). **Gate:** AE = 0, or `diff.png` (Read it) shows only data/clock text that changed between runs.
4. Fixture: open `http://localhost:3217/dev/elements` in light and dark, screenshot both, **Read the PNGs**. **Gate:** borders visible but subtle, text legible in both modes, user bubble grey (not brand-coloured), tool states each show their badge, CoT collapsible opens.
5. Image embed: `playwright-cli eval "() => [...document.querySelectorAll('[data-ai-elements] img')].map(i => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0 }))"`. **Gate:** the `/api/images/.../raw` image reports `ok: true`. If `vue-stream-markdown` strips or blocks the relative URL, check its README for an allow-list / `urlTransform` option and configure it in `MessageResponse.vue`; if that is impossible, **fallback:** make `MessageResponse.vue` render our `<MdView :source="md" :cache-key="cacheKey" />` (add a required `cacheKey` prop) instead of `<Markdown>`, and record the decision.
6. MDC audit: `grep -n -E '::|\{[a-z]+=' server/lib/agent/prompt.ts` and, in dev, `playwright-cli eval "async () => (await (await fetch('/api/conversations?limit=5')).json())"` then open two threads' messages — look for MDC-only syntax (`::component`, `{attr=…}`) in assistant content. **Gate:** none found (or the fallback above is taken).

- [ ] **Step 8: Decide and record**

Write `.superpowers/sdd/2026-09-19-agent-elements-foundation/spike/REPORT.md`: every gate's result, dependency list, token edits, bundle numbers, any fallback taken. **If any gate fails and has no recorded fallback: STOP the cycle and report to Tony — do not continue to Task 1.**

- [ ] **Step 9: Commit**

```bash
git add components.json app/lib/utils.ts app/components/ui app/components/ai-elements app/pages/dev/elements.vue app/assets/css/main.css nuxt.config.ts package.json pnpm-lock.yaml
git commit -m "feat(agent-ui): install AI Elements Vue beside Nuxt UI behind a token bridge"
```

---

### Task 1: Shared UI message types and helpers

**Files:**
- Create: `shared/types/agent-ui.ts`, `shared/utils/agent-ui.ts`, `shared/utils/agent-ui.test.ts`
- Modify: `shared/types/conversation.ts` (`ToolCallRecordDTO.steps`), `server/lib/agent/tool-history.ts` (`AgentToolRecord.steps`), `server/lib/agent/tool-history.test.ts`

**Interfaces:**
- Produces (types): `AgentToolKind`, `SubagentStep`, `ToolEnvelope`, `AgentMessageMetadata`, `AgentDataParts`, `AgentUIMessage`, `AgentUIPart`, `AgentUIChunk`, `AgentMessageFrame`.
- Produces (functions): `toolOutcome(result: unknown): ToolOutcome`, `toolEnvelope(o: { result: unknown; summary: string; undoToken?: string; kind?: AgentToolKind }): ToolEnvelope`, `attachmentUrl(a: AttachmentRef): string`, `attachmentToFilePart(a: AttachmentRef): FileUIPart`.

- [ ] **Step 1: Write the failing tests** — `shared/utils/agent-ui.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { toolOutcome, toolEnvelope, attachmentUrl, attachmentToFilePart } from './agent-ui'

describe('toolOutcome', () => {
  it('reads the shapes ai-tools returns', () => {
    expect(toolOutcome({ hits: 3 })).toEqual({ state: 'ok' })
    expect(toolOutcome({ error: 'boom' })).toEqual({ state: 'error', errorText: 'boom' })
    expect(toolOutcome({ denied: true })).toEqual({ state: 'denied' })
  })
  it('treats non-objects and non-string errors as ok', () => {
    expect(toolOutcome(undefined)).toEqual({ state: 'ok' })
    expect(toolOutcome('text')).toEqual({ state: 'ok' })
    expect(toolOutcome({ error: { code: 1 } })).toEqual({ state: 'ok' })
    expect(toolOutcome({ denied: 'yes' })).toEqual({ state: 'ok' })
  })
})

describe('toolEnvelope', () => {
  it('keeps value + summary and omits absent optionals', () => {
    expect(toolEnvelope({ result: { a: 1 }, summary: 's' })).toEqual({ value: { a: 1 }, summary: 's' })
    expect(toolEnvelope({ result: 1, summary: 's', undoToken: 'u', kind: 'create' }))
      .toEqual({ value: 1, summary: 's', undoToken: 'u', kind: 'create' })
  })
})

describe('attachments', () => {
  it('maps images and files to their serving routes', () => {
    expect(attachmentUrl({ id: 'i1', kind: 'image', mime: 'image/png' })).toBe('/api/images/i1/raw')
    expect(attachmentUrl({ id: 'f1', kind: 'file', mime: 'application/pdf' })).toBe('/api/agent/files/f1')
  })
  it('builds a FileUIPart, carrying the filename only when known', () => {
    expect(attachmentToFilePart({ id: 'f1', kind: 'file', mime: 'application/pdf', name: 'a.pdf' }))
      .toEqual({ type: 'file', mediaType: 'application/pdf', url: '/api/agent/files/f1', filename: 'a.pdf' })
    expect(attachmentToFilePart({ id: 'i1', kind: 'image', mime: 'image/png' }))
      .toEqual({ type: 'file', mediaType: 'image/png', url: '/api/images/i1/raw' })
  })
})
```

Append to `server/lib/agent/tool-history.test.ts`:

```ts
describe('toolBlocksFor ignores subagent steps', () => {
  it('produces identical model blocks with and without steps', () => {
    const base = { callId: 'c1', name: 'research_web', kind: 'read' as const, args: { task: 't' }, result: { report: 'r' }, summary: 's', textOffset: 0 }
    const withSteps = { ...base, steps: [{ callId: 'n1', name: 'web_search', summary: 'searched', state: 'done' as const }] }
    expect(toolBlocksFor([withSteps])).toEqual(toolBlocksFor([base]))
  })
})
```

(`toolBlocksFor` and `describe/it/expect` are already imported in that file; if not, import them.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run shared/utils/agent-ui.test.ts server/lib/agent/tool-history.test.ts`
Expected: FAIL — `Cannot find module './agent-ui'`; the tool-history test fails typecheck-free but may pass at runtime (it is a guard; it must still pass after Step 3).

- [ ] **Step 3: Implement**

`shared/types/agent-ui.ts`:

```ts
// The agent's UI message model: AI SDK UIMessages with our metadata, one custom data part
// (a subagent's nested steps) and dynamic tool parts whose `output` is a ToolEnvelope.
// Shared by the server encoder (server/lib/voice/ui-stream.ts), the client assembler
// (app/lib/agent/turn-stream.ts) and resume (app/lib/agent/to-ui-messages.ts).
import type { UIMessage, UIMessageChunk } from 'ai'
import type { AttachmentRef, MessageUsage } from './conversation'

export type AgentToolKind = 'read' | 'create' | 'destructive'

/** One nested call inside a subagent run. Persisted on the parent tool record with terminal states only. */
export interface SubagentStep {
  callId: string
  name: string
  summary?: string
  state: 'running' | 'done' | 'error'
}

/** A tool part's `output`: the persist-capped result plus the metadata the UI needs. */
export interface ToolEnvelope {
  value: unknown
  summary: string
  undoToken?: string
  kind?: AgentToolKind
}

export interface AgentMessageMetadata {
  createdAt?: string
  usage?: MessageUsage
  /** User messages only — the refs sent with the turn (retry re-sends them). */
  attachments?: AttachmentRef[]
  /** Client-side: stopped, barged in on, or superseded by a newer turn. */
  interrupted?: true
  /** Client-side: the turn ended with an error chunk or the socket dropped. */
  errorText?: string
}

// A type alias (not an interface) so it satisfies the SDK's `UIDataTypes` index signature.
export type AgentDataParts = {
  subagent: { steps: SubagentStep[] }
}

export type AgentUIMessage = UIMessage<AgentMessageMetadata, AgentDataParts>
export type AgentUIPart = AgentUIMessage['parts'][number]
export type AgentUIChunk = UIMessageChunk<AgentMessageMetadata, AgentDataParts>

/** The WS frames that carry the message protocol (audio/state/approval frames are separate). */
export type AgentMessageFrame =
  | { type: 'chunk'; turnId: number; chunk: AgentUIChunk }
  | { type: 'user-message'; turnId: number; message: AgentUIMessage }
```

`shared/utils/agent-ui.ts`:

```ts
// Pure helpers used on BOTH sides of the wire, so the live stream and a resumed thread
// derive tool state and attachment parts identically (the parity test depends on it).
import type { FileUIPart } from 'ai'
import type { AttachmentRef } from '../types/conversation'
import type { AgentToolKind, ToolEnvelope } from '../types/agent-ui'

export type ToolOutcome = { state: 'ok' } | { state: 'error'; errorText: string } | { state: 'denied' }

/** How a finished call ended, read from what ai-tools returns: a thrown handler → `{ error }`,
 *  an exec denial → `{ denied: true }`. Anything else is a normal result. */
export function toolOutcome(result: unknown): ToolOutcome {
  if (result && typeof result === 'object') {
    const r = result as { denied?: unknown; error?: unknown }
    if (r.denied === true) return { state: 'denied' }
    if (typeof r.error === 'string') return { state: 'error', errorText: r.error }
  }
  return { state: 'ok' }
}

export function toolEnvelope(o: { result: unknown; summary: string; undoToken?: string; kind?: AgentToolKind }): ToolEnvelope {
  return {
    value: o.result,
    summary: o.summary,
    ...(o.undoToken ? { undoToken: o.undoToken } : {}),
    ...(o.kind ? { kind: o.kind } : {})
  }
}

export function attachmentUrl(a: AttachmentRef): string {
  return a.kind === 'image' ? `/api/images/${a.id}/raw` : `/api/agent/files/${a.id}`
}

export function attachmentToFilePart(a: AttachmentRef): FileUIPart {
  return { type: 'file', mediaType: a.mime, url: attachmentUrl(a), ...(a.name ? { filename: a.name } : {}) }
}
```

In `shared/types/conversation.ts`, add to `ToolCallRecordDTO` (and the import at the top):

```ts
import type { SubagentStep } from './agent-ui'
// …inside ToolCallRecordDTO, after textOffset:
  /** A subagent's nested calls (terminal states only). Display-only — never sent to the model. */
  steps?: SubagentStep[]
```

In `server/lib/agent/tool-history.ts`, add to `AgentToolRecord` (and `import type { SubagentStep } from '../../../shared/types/agent-ui'`):

```ts
  /** A subagent's nested calls (terminal states only). toolBlocksFor ignores it: display-only. */
  steps?: SubagentStep[]
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run shared/utils/agent-ui.test.ts server/lib/agent/tool-history.test.ts && pnpm typecheck`
Expected: PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add shared/types/agent-ui.ts shared/utils/agent-ui.ts shared/utils/agent-ui.test.ts shared/types/conversation.ts server/lib/agent/tool-history.ts server/lib/agent/tool-history.test.ts
git commit -m "feat(agent-ui): shared UIMessage types and the tool-outcome/envelope helpers"
```

---

### Task 2: `runAgent` delivers tool events live (callId on tool-start, nested events, event channel)

**Files:**
- Modify: `server/lib/agent/types.ts`, `server/lib/agent/ai-tools.ts`, `server/lib/agent/run.ts`
- Test: `server/lib/agent/run-live-events.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `types.ts`: `ToolStartEvent = { type: 'tool-start'; name: string; args: Record<string, unknown>; callId?: string }`, `ToolResultEvent = { type: 'tool-result'; name: string; summary: string; undoToken?: string; images?: DisplayImage[]; callId?: string; args?: Record<string, unknown>; result?: unknown; kind?: ToolKind }`, `NestedToolEvent = ToolStartEvent | ToolResultEvent`, `SubagentEvent = { type: 'subagent-event'; parentCallId: string; event: NestedToolEvent }`, and `ToolContext.onNestedEvent?: (e: NestedToolEvent) => void`.
  - `run.ts`: `AgentEvent` now includes `ToolStartEvent` (with `callId`), `ToolResultEvent` and `SubagentEvent`.

- [ ] **Step 1: Write the failing tests** — `server/lib/agent/run-live-events.test.ts`

```ts
// Proves tool lifecycle events reach runAgent's consumer WHILE the tool is still running.
// Uses the REAL streamText with a mock model: the property under test is how the SDK's
// fullStream behaves during execute(), which a hand-written fake stream cannot reproduce.
import { describe, it, expect } from 'vitest'
import { streamText } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import { runAgent, type AgentEvent } from './run'
import type { AgentTool } from './types'

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
function mockModel() {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      call++
      const chunks = call === 1
        ? [{ type: 'tool-call', toolCallId: 'c1', toolName: 'slow', input: '{}' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }]
        : [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }]
      return { stream: convertArrayToReadableStream(chunks as never) }
    }
  })
}

async function runWithGatedTool() {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const tool: AgentTool = {
    name: 'slow', description: 'slow', kind: 'read', schema: {},
    handler: async (_input, ctx) => {
      ctx.onNestedEvent?.({ type: 'tool-start', name: 'web_search', args: { q: 'x' }, callId: 'n1' })
      await gate
      return { result: { ok: true }, summary: 'slow done' }
    }
  }
  const model = mockModel()
  const seen: AgentEvent[] = []
  const consumed = (async () => {
    for await (const e of runAgent(
      [{ role: 'user', content: 'hi' }],
      { signal: new AbortController().signal, maxSteps: 3 },
      { streamText: ((a: object) => streamText({ ...(a as never), model })) as never, tools: [tool], buildSystemPrompt: async () => 's' }
    )) seen.push(e)
  })()
  await new Promise(r => setTimeout(r, 200)) // the tool is now parked on the gate
  const beforeRelease = [...seen]
  release()
  await consumed
  return { beforeRelease, all: seen }
}

describe('runAgent live tool events', () => {
  it('stamps tool-start with the SDK toolCallId', async () => {
    const { all } = await runWithGatedTool()
    expect(all.find(e => e.type === 'tool-start')).toMatchObject({ name: 'slow', callId: 'c1' })
  })

  it('forwards a nested event as subagent-event keyed to the parent call', async () => {
    const { all } = await runWithGatedTool()
    expect(all.find(e => e.type === 'subagent-event')).toEqual({
      type: 'subagent-event', parentCallId: 'c1',
      event: { type: 'tool-start', name: 'web_search', args: { q: 'x' }, callId: 'n1' }
    })
  })

  it('delivers the nested event BEFORE the tool finishes (no end-of-tool burst)', async () => {
    const { beforeRelease } = await runWithGatedTool()
    expect(beforeRelease.map(e => e.type)).toEqual(['tool-start', 'subagent-event'])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run server/lib/agent/run-live-events.test.ts`
Expected: FAIL — all three (`callId` missing on tool-start; `onNestedEvent` does not exist so no `subagent-event`).

- [ ] **Step 3: Types + the per-call nested hook**

In `server/lib/agent/types.ts`, add `onNestedEvent` to `ToolContext` and the event types (keep `LoopEvent` as is):

```ts
/** Per-call context handed to every tool handler. */
export interface ToolContext {
  signal: AbortSignal // aborts when the caller hangs up / barge-in
  // Present only on the interactive (WS) path; a dangerous tool with no channel auto-denies.
  requestApproval?: (req: ApprovalRequest) => Promise<{ approved: boolean }>
  attachmentImageIds?: string[]  // image attachments of the current turn (edit_image source)
  /** A tool that runs its own agent loop (a subagent) reports each nested call here; ai-tools
   *  re-emits it as a `subagent-event` keyed to THIS call's toolCallId. */
  onNestedEvent?: (e: NestedToolEvent) => void
}

export type ToolStartEvent = { type: 'tool-start'; name: string; args: Record<string, unknown>; callId?: string }
export type ToolResultEvent = { type: 'tool-result'; name: string; summary: string; undoToken?: string; images?: DisplayImage[]; callId?: string; args?: Record<string, unknown>; result?: unknown; kind?: ToolKind }
export type NestedToolEvent = ToolStartEvent | ToolResultEvent
export type SubagentEvent = { type: 'subagent-event'; parentCallId: string; event: NestedToolEvent }
```

In `server/lib/agent/ai-tools.ts`:
- Change `RunHooks.onEvent` to `onEvent: (e: ToolStartEvent | ToolResultEvent | SubagentEvent) => void` and import those types from `./types`.
- Inside `execute`, right after `const callId = opts?.toolCallId ?? ''`, build the per-call context and use it for `autoApprove` and `handler` (both currently receive `ctx`):

```ts
        // Per-call context: a subagent's nested calls are keyed to THIS call's id, which
        // only exists here — the shared `ctx` above is built once for the whole toolset.
        const callCtx: ToolContext = {
          ...ctx,
          onNestedEvent: e => hooks.onEvent({ type: 'subagent-event', parentCallId: callId, event: e })
        }
```

- Change `hooks.onEvent({ type: 'tool-start', name: t.name, args: safeArgs })` to `hooks.onEvent({ type: 'tool-start', name: t.name, args: safeArgs, callId })`.
- Change `t.autoApprove(input, ctx)` → `t.autoApprove(input, callCtx)` and `() => t.handler(input, ctx)` → `() => t.handler(input, callCtx)`.

In `server/lib/agent/run.ts`, replace the `tool-start`/`tool-result` members of `AgentEvent` with the shared types:

```ts
import type { AgentTool, ToolStartEvent, ToolResultEvent, SubagentEvent } from './types'

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | ToolStartEvent
  | ToolResultEvent
  | SubagentEvent
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; totalTokens?: number }
  | { type: 'done' }
```

Run: `pnpm vitest run server/lib/agent/run-live-events.test.ts`
Expected: the first two tests PASS; **the third still FAILS** (`beforeRelease` is `['tool-start']` — the nested event is stuck in the queue until the tool returns). That failure is the burst this task exists to fix; confirm it before Step 4.

- [ ] **Step 4: The event channel**

In `server/lib/agent/run.ts`, add above `runAgent`:

```ts
// One ordered channel that BOTH the model stream and tool callbacks push into. The old design
// (an array drained only when the next fullStream part arrived) could not deliver an event a
// tool emits while it is still executing: the SDK emits no parts during a pending execute(),
// so a subagent's nested calls reached the UI in one burst when it finished (verified against
// the real SDK, 2026-09-19 — see run-live-events.test.ts).
type ChannelItem = { kind: 'event'; ev: AgentEvent } | { kind: 'part'; part: unknown } | { kind: 'error'; err: unknown }

function createChannel() {
  const items: ChannelItem[] = []
  let wake: (() => void) | null = null
  let closed = false
  const notify = () => { const w = wake; wake = null; w?.() }
  return {
    push(item: ChannelItem) { items.push(item); notify() },
    close() { closed = true; notify() },
    async *drain(): AsyncGenerator<ChannelItem> {
      while (true) {
        while (items.length) yield items.shift()!
        if (closed) return
        await new Promise<void>((resolve) => { wake = resolve })
      }
    }
  }
}
type Channel = ReturnType<typeof createChannel>

/** Copy a model stream into the channel, then close it. A stream error becomes an item so it
 *  is rethrown IN ORDER by the consumer, exactly where the old for-await would have thrown. */
function pump(stream: AsyncIterable<unknown>, ch: Channel): Promise<void> {
  return (async () => {
    try { for await (const part of stream) ch.push({ kind: 'part', part }) } catch (err) { ch.push({ kind: 'error', err }) } finally { ch.close() }
  })()
}
```

Inside `runAgent`:
- Replace `const queue: AgentEvent[] = []` with `let channel = createChannel()`.
- Change the tools' hook to `onEvent: e => channel.push({ kind: 'event', ev: e })`.
- Replace the main loop (`for await (const part of result.fullStream) { … }` and the trailing `while (queue.length) yield queue.shift()!`) with:

```ts
  const mainPump = pump(result.fullStream, channel)
  for await (const item of channel.drain()) {
    if (item.kind === 'event') { yield item.ev; continue }
    if (item.kind === 'error') throw item.err
    const part = item.part
    if ((part as { type?: unknown }).type === 'tool-call') sawToolCall = true
    const ev = partToEvent(part)
    if (ev) { if (ev.type === 'text-delta') { sawText = true; emittedText += ev.text } ; yield ev }
    const usageEv = partToUsageEvent(part)
    if (usageEv) yield usageEv
  }
  await mainPump
```

- In the forced-final follow-up, replace its `for await (const part of followup.fullStream) { … }` and trailing `while (queue.length) …` with:

```ts
      channel = createChannel()
      const followupPump = pump(followup.fullStream, channel)
      for await (const item of channel.drain()) {
        if (item.kind === 'event') { yield item.ev; continue }
        if (item.kind === 'error') throw item.err
        const ev = partToEvent(item.part)
        if (ev) { if (ev.type === 'text-delta') followupText = true; yield ev }
        // This is a SEPARATE streamText call, so its usage does not include the aborted
        // main call's tokens — it supersedes (not adds to) any usage already yielded above,
        // since it's what actually produced the text the user sees.
        const usageEv = partToUsageEvent(item.part)
        if (usageEv) yield usageEv
      }
      await followupPump
```

(The follow-up is inside the existing `try { … } catch (err) { recordEvent(…) }`, so a rethrown stream error is still recorded there, as before.)

- [ ] **Step 5: Run to verify pass (new + existing)**

Run: `pnpm vitest run server/lib/agent/ test/run-agent.test.ts test/obs-failover.test.ts && pnpm typecheck`
Expected: PASS, including all three live-event tests and every existing `runAgent` test.

- [ ] **Step 6: Commit**

```bash
git add server/lib/agent/types.ts server/lib/agent/ai-tools.ts server/lib/agent/run.ts server/lib/agent/run-live-events.test.ts
git commit -m "feat(agent): deliver tool events live — callId on tool-start, nested events, one ordered channel"
```

---

### Task 3: Subagents forward their nested calls

**Files:**
- Modify: `server/lib/agent/subagents.ts`
- Test: `server/lib/agent/subagents.test.ts`

**Interfaces:**
- Consumes: `ToolContext.onNestedEvent` (Task 2).
- Produces: a subagent tool calls `ctx.onNestedEvent` once per nested `tool-start` and `tool-result`, in order.

- [ ] **Step 1: Write the failing test** — append to `server/lib/agent/subagents.test.ts`

```ts
describe('makeSubagentTool nested event forwarding', () => {
  it('forwards each nested tool-start and tool-result, in order, and nothing else', async () => {
    const forwarded: unknown[] = []
    const tool = makeSubagentTool(SPEC, {
      run: fakeRun([
        { type: 'tool-start', name: 'web_search', args: { q: 'a' }, callId: 'n1' },
        { type: 'tool-result', name: 'web_search', summary: 'searched (3)', callId: 'n1', result: { hits: 3 } },
        { type: 'text-delta', text: 'Report.' },
        { type: 'done' }
      ])
    })
    const out = await tool.handler({ task: 'find X' }, { signal: new AbortController().signal, onNestedEvent: e => forwarded.push(e) })
    expect(forwarded).toEqual([
      { type: 'tool-start', name: 'web_search', args: { q: 'a' }, callId: 'n1' },
      { type: 'tool-result', name: 'web_search', summary: 'searched (3)', callId: 'n1', result: { hits: 3 } }
    ])
    expect(out.result).toEqual({ report: 'Report.' })
    expect(out.summary).toBe('tested: find X (1 tool calls)')
  })

  it('still works without a nested hook', async () => {
    const tool = makeSubagentTool(SPEC, { run: fakeRun([{ type: 'tool-start', name: 'web_search', args: {} }, { type: 'text-delta', text: 'ok' }]) })
    await expect(tool.handler({ task: 'x' }, { signal: new AbortController().signal })).resolves.toMatchObject({ result: { report: 'ok' } })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run server/lib/agent/subagents.test.ts`
Expected: FAIL — `forwarded` is `[]`.

- [ ] **Step 3: Implement** — in `makeSubagentTool`'s handler loop:

```ts
      )) {
        if (ev.type === 'text-delta') report += ev.text
        else if (ev.type === 'tool-start') ctx.onNestedEvent?.(ev)
        else if (ev.type === 'tool-result') { toolCalls++; ctx.onNestedEvent?.(ev) }
      }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run server/lib/agent/subagents.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/subagents.ts server/lib/agent/subagents.test.ts
git commit -m "feat(agent): subagents forward their nested tool calls to the parent"
```

---

### Task 4: Orchestrator emits the tool lifecycle and records subagent steps

**Files:**
- Modify: `server/lib/voice/orchestrator.ts`
- Test: `server/lib/voice/orchestrator-tool-events.test.ts` (new)

**Interfaces:**
- Consumes: `AgentEvent` incl. `SubagentEvent` (Task 2), `toolOutcome` (Task 1), `SubagentStep` (Task 1).
- Produces — `VoiceEvent` gains / changes:
  - `{ type: 'tool-start'; callId: string; name: string; args: Record<string, unknown> }` — args already `capArgs(…, ARGS_WRITE_CAP)`.
  - `tool` becomes `{ type: 'tool'; name: string; summary: string; undoToken?: string; images?: DisplayImage[]; callId?: string; args?: Record<string, unknown>; result?: unknown; kind?: ToolKind }` — `args`/`result` are the **same capped copies** written to the tool record.
  - `{ type: 'subagent'; parentCallId: string; steps: SubagentStep[] }` — the full current list each time.
  - The returned assistant message's `toolRecords[i].steps` holds that call's steps with every `running` mapped to `error`.

- [ ] **Step 1: Write the failing test** — `server/lib/voice/orchestrator-tool-events.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { handleTurn, type VoiceEvent } from './orchestrator'
import type { AgentEvent } from '../agent/run'
import type { NestedToolEvent } from '../agent/types'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'
import { ARGS_WRITE_CAP } from '../agent/tool-history'

const preset: VoicePresetDTO = {
  id: 'p1', name: 'n', instruction: 'A calm man.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: null, refText: null, refDurationMs: null,
  maxSegmentChars: 200, calibratedRefKey: null, refSource: null, starredSeeds: [], isDefault: true
}

async function run(agentEvents: AgentEvent[]) {
  const events: VoiceEvent[] = []
  const out = await handleTurn('research orpheus', [], {
    tts: { async *synthesize() {} } as never, preset, signal: new AbortController().signal, speak: false,
    emit: e => { events.push(e) },
    async *runAgent() { for (const e of agentEvents) yield e }
  })
  return { events, out }
}

const nested = (event: NestedToolEvent): AgentEvent => ({ type: 'subagent-event', parentCallId: 'c1', event })

describe('handleTurn tool lifecycle events', () => {
  it('emits tool-start with the callId and CAPPED args', async () => {
    const big = { content: 'x'.repeat(ARGS_WRITE_CAP * 2) }
    const { events } = await run([{ type: 'tool-start', name: 'save_document', args: big, callId: 'c1' }])
    const start = events.find(e => e.type === 'tool-start') as Extract<VoiceEvent, { type: 'tool-start' }>
    expect(start).toMatchObject({ callId: 'c1', name: 'save_document' })
    expect(start.args).toMatchObject({ truncated: true })
  })

  it('emits the tool result with the same capped args/result it persists', async () => {
    const { events, out } = await run([
      { type: 'tool-start', name: 'search_docs', args: { q: 'a' }, callId: 'c1' },
      { type: 'tool-result', name: 'search_docs', summary: 'found 2', callId: 'c1', args: { q: 'a' }, result: { hits: 2 }, kind: 'read' }
    ])
    const tool = events.find(e => e.type === 'tool') as Extract<VoiceEvent, { type: 'tool' }>
    expect(tool).toMatchObject({ callId: 'c1', name: 'search_docs', summary: 'found 2', args: { q: 'a' }, result: { hits: 2 }, kind: 'read' })
    const record = (out.at(-1) as { toolRecords?: unknown[] } | undefined)?.toolRecords
    expect(record).toBeUndefined() // no assistant text → no assistant message (existing rule)
  })

  it('accumulates subagent steps, emits the full list each time, and persists terminal states', async () => {
    const { events, out } = await run([
      { type: 'tool-start', name: 'research_web', args: { task: 't' }, callId: 'c1' },
      nested({ type: 'tool-start', name: 'web_search', args: { q: 'a' }, callId: 'n1' }),
      nested({ type: 'tool-result', name: 'web_search', summary: 'searched (3)', callId: 'n1', result: { hits: 3 } }),
      nested({ type: 'tool-start', name: 'web_fetch', args: { url: 'u' }, callId: 'n2' }),
      nested({ type: 'tool-result', name: 'web_fetch', summary: 'failed: web_fetch', callId: 'n2', result: { error: '403' } }),
      nested({ type: 'tool-start', name: 'web_fetch', args: { url: 'v' }, callId: 'n3' }),
      { type: 'tool-result', name: 'research_web', summary: 'research: t (2 tool calls)', callId: 'c1', args: { task: 't' }, result: { report: 'r' }, kind: 'read' },
      { type: 'text-delta', text: 'Done.' }
    ])
    const sub = events.filter(e => e.type === 'subagent') as Extract<VoiceEvent, { type: 'subagent' }>[]
    expect(sub).toHaveLength(5)
    expect(sub[0]).toEqual({ type: 'subagent', parentCallId: 'c1', steps: [{ callId: 'n1', name: 'web_search', state: 'running' }] })
    expect(sub[4]!.steps).toEqual([
      { callId: 'n1', name: 'web_search', summary: 'searched (3)', state: 'done' },
      { callId: 'n2', name: 'web_fetch', summary: 'failed: web_fetch', state: 'error' },
      { callId: 'n3', name: 'web_fetch', state: 'running' }
    ])
    const assistant = out.at(-1) as { role: string; toolRecords?: { steps?: unknown }[] }
    expect(assistant.role).toBe('assistant')
    expect(assistant.toolRecords![0]!.steps).toEqual([
      { callId: 'n1', name: 'web_search', summary: 'searched (3)', state: 'done' },
      { callId: 'n2', name: 'web_fetch', summary: 'failed: web_fetch', state: 'error' },
      { callId: 'n3', name: 'web_fetch', state: 'error' } // never finished → not left "running" forever
    ])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run server/lib/voice/orchestrator-tool-events.test.ts`
Expected: FAIL — no `tool-start` / `subagent` VoiceEvents.

- [ ] **Step 3: Implement** — in `server/lib/voice/orchestrator.ts`

Imports:

```ts
import type { SubagentStep, AgentToolKind } from '../../../shared/types/agent-ui'
import { toolOutcome } from '../../../shared/utils/agent-ui'
```

Replace the `VoiceEvent` union's `tool` member and add two members:

```ts
  | { type: 'tool-start'; callId: string; name: string; args: Record<string, unknown> }
  // args/result are the CAPPED copies also written to the tool record, so the live UI shows
  // exactly what a resumed thread will show.
  | { type: 'tool'; name: string; summary: string; undoToken?: string; images?: DisplayImage[]; callId?: string; args?: Record<string, unknown>; result?: unknown; kind?: AgentToolKind }
  | { type: 'subagent'; parentCallId: string; steps: SubagentStep[] }
```

Before the `for await (const ev of run(…))` loop, add:

```ts
  // A subagent's nested calls, keyed by the PARENT call — emitted live as the full list and
  // persisted (terminal states only) on the parent's tool record.
  const subagentSteps = new Map<string, SubagentStep[]>()
```

In the loop, replace the `tool-start` and `tool-result` branches and add a `subagent-event` branch:

```ts
    } else if (ev.type === 'tool-start') {
      deps.emit({ type: 'state', state: 'tool' })
      if (ev.callId) deps.emit({ type: 'tool-start', callId: ev.callId, name: ev.name, args: capArgs(ev.args, ARGS_WRITE_CAP) })
    } else if (ev.type === 'subagent-event') {
      const steps = subagentSteps.get(ev.parentCallId) ?? []
      const n = ev.event
      if (n.type === 'tool-start') {
        steps.push({ callId: n.callId ?? `${ev.parentCallId}-n${steps.length}`, name: n.name, state: 'running' })
      } else {
        const i = n.callId ? steps.findIndex(s => s.callId === n.callId) : steps.findIndex(s => s.name === n.name && s.state === 'running')
        const done: SubagentStep = { callId: n.callId ?? `${ev.parentCallId}-n${steps.length}`, name: n.name, summary: n.summary, state: toolOutcome(n.result).state === 'ok' ? 'done' : 'error' }
        if (i >= 0) steps[i] = done
        else steps.push(done)
      }
      subagentSteps.set(ev.parentCallId, steps)
      deps.emit({ type: 'subagent', parentCallId: ev.parentCallId, steps: steps.map(s => ({ ...s })) })
    } else if (ev.type === 'tool-result') {
      if (ev.images?.length) turnImages.push(...ev.images)
      // Capped ONCE: the same objects are persisted and sent live (UI parity with resume).
      const args = capArgs(ev.args, ARGS_WRITE_CAP)
      const result = capResult(ev.result, WRITE_RESULT_CAP)
      if (ev.callId) {
        const steps = subagentSteps.get(ev.callId)
        toolRecords.push({
          // BOTH payloads are capped at capture: a write tool's args carry the whole document
          // body, and an uncapped one would be persisted and re-sent on every later turn.
          callId: ev.callId, name: ev.name, kind: ev.kind ?? 'read',
          args, result, summary: ev.summary,
          // Offset into the SANITIZED text, not the raw stream: what gets persisted below is
          // applyImageEmbeds(assistantText).content, which trims and collapses whitespace, so
          // a raw length would index a string that no longer exists (see sanitizedOffset).
          undoToken: ev.undoToken, textOffset: sanitizedOffset(assistantText),
          ...(steps?.length ? { steps: steps.map(s => s.state === 'running' ? { ...s, state: 'error' as const } : s) } : {})
        })
      }
      deps.emit({ type: 'tool', name: ev.name, summary: ev.summary, undoToken: ev.undoToken, images: ev.images, callId: ev.callId, args, result, kind: ev.kind })
      deps.emit({ type: 'state', state: 'thinking' })
    }
```

- [ ] **Step 4: Run to verify pass (new + all orchestrator suites)**

Run: `pnpm vitest run server/lib/voice/ test/orchestrator.test.ts test/agent-memory-context.test.ts && pnpm typecheck`
Expected: PASS. (Existing suites match `tool` events loosely, so the added fields do not break them. If any asserts a `tool` event with `toEqual`, change that one assertion to `toMatchObject` with the same object.)

- [ ] **Step 5: Commit**

```bash
git add server/lib/voice/orchestrator.ts server/lib/voice/orchestrator-tool-events.test.ts
git commit -m "feat(voice): emit the tool lifecycle and a subagent's steps; persist the steps on the parent record"
```

---

### Task 5: The `VoiceEvent → UIMessageChunk` encoder

**Files:**
- Create: `server/lib/voice/ui-stream.ts`, `server/lib/voice/ui-stream.test.ts`

**Interfaces:**
- Consumes: `VoiceEvent` (Task 4), `AgentUIChunk` / `AgentUIMessage` (Task 1), `toolOutcome` / `toolEnvelope` (Task 1).
- Produces:

```ts
export interface UIChunkEncoder {
  start(createdAt: string): AgentUIChunk[]
  encode(e: VoiceEvent): AgentUIChunk[]
  finish(): AgentUIChunk[]
  error(errorText: string): AgentUIChunk[]
  abort(): AgentUIChunk[]
}
export function createUIChunkEncoder(messageId: string): UIChunkEncoder
```

Ignored VoiceEvents (return `[]`): `transcript` with `role: 'user'`, `state`, `audio-begin`, `audio`, `audio-end`.

- [ ] **Step 1: Write the failing tests** — `server/lib/voice/ui-stream.test.ts`

```ts
// Every assertion runs the encoder's output through the SDK's REAL assembler, so a pass means
// "readUIMessageStream builds this message", not "we emitted what we think the docs say".
import { describe, it, expect } from 'vitest'
import { readUIMessageStream } from 'ai'
import { createUIChunkEncoder } from './ui-stream'
import type { VoiceEvent } from './orchestrator'
import type { AgentUIChunk, AgentUIMessage } from '../../../shared/types/agent-ui'

async function assemble(chunks: AgentUIChunk[]): Promise<{ message: AgentUIMessage; errors: string[] }> {
  const stream = new ReadableStream<AgentUIChunk>({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close() } })
  const errors: string[] = []
  let message: AgentUIMessage | undefined
  for await (const m of readUIMessageStream<AgentUIMessage>({ stream, onError: e => errors.push(String(e)) })) message = m
  return { message: message!, errors }
}

function encodeTurn(events: VoiceEvent[], end: 'finish' | 'error' | 'abort' = 'finish') {
  const enc = createUIChunkEncoder('m1')
  const chunks = [...enc.start('2026-09-19T00:00:00.000Z'), ...events.flatMap(e => enc.encode(e))]
  chunks.push(...(end === 'finish' ? enc.finish() : end === 'error' ? enc.error('boom') : enc.abort()))
  return chunks
}

const visible = (m: AgentUIMessage) => m.parts.filter(p => p.type !== 'step-start')
const text = (t: string): VoiceEvent => ({ type: 'transcript', role: 'assistant', text: t })

describe('createUIChunkEncoder', () => {
  it('interleaves text and a finished tool in stream order', async () => {
    const { message } = await assemble(encodeTurn([
      text('Looking. '),
      { type: 'tool-start', callId: 'c1', name: 'search_docs', args: { q: 'a' } },
      { type: 'tool', callId: 'c1', name: 'search_docs', summary: 'found 2', args: { q: 'a' }, result: { hits: 2 }, kind: 'read', undoToken: 'u1' },
      text('Found '), text('it.')
    ]))
    expect(message.id).toBe('m1')
    expect(message.metadata).toEqual({ createdAt: '2026-09-19T00:00:00.000Z' })
    expect(visible(message)).toEqual([
      { type: 'text', text: 'Looking. ', state: 'done' },
      { type: 'dynamic-tool', toolName: 'search_docs', toolCallId: 'c1', state: 'output-available', input: { q: 'a' },
        output: { value: { hits: 2 }, summary: 'found 2', undoToken: 'u1', kind: 'read' } },
      { type: 'text', text: 'Found it.', state: 'done' }
    ])
  })

  it('shows a running tool as input-available until its result arrives', async () => {
    const enc = createUIChunkEncoder('m1')
    const chunks = [...enc.start('t'), ...enc.encode({ type: 'tool-start', callId: 'c1', name: 'web_fetch', args: { url: 'u' } })]
    const { message } = await assemble(chunks)
    expect(visible(message)).toEqual([{ type: 'dynamic-tool', toolName: 'web_fetch', toolCallId: 'c1', state: 'input-available', input: { url: 'u' } }])
  })

  it('maps an { error } result to output-error', async () => {
    const { message } = await assemble(encodeTurn([
      { type: 'tool-start', callId: 'c1', name: 'web_fetch', args: {} },
      { type: 'tool', callId: 'c1', name: 'web_fetch', summary: 'failed: web_fetch', args: {}, result: { error: '403' } }
    ]))
    expect(visible(message)[0]).toMatchObject({ state: 'output-error', errorText: '403' })
  })

  it('maps a { denied: true } result to output-denied', async () => {
    const { message } = await assemble(encodeTurn([
      { type: 'tool-start', callId: 'c1', name: 'exec', args: { command: 'rm -rf /' } },
      { type: 'tool', callId: 'c1', name: 'exec', summary: 'denied: exec', args: {}, result: { denied: true } }
    ]))
    expect(visible(message)[0]).toMatchObject({ toolCallId: 'c1', state: 'output-denied' })
  })

  it('synthesizes the input for a result whose tool-start was never seen', async () => {
    const { message } = await assemble(encodeTurn([
      { type: 'tool', callId: 'c9', name: 'x', summary: 's', args: { a: 1 }, result: { ok: true } }
    ]))
    expect(visible(message)[0]).toMatchObject({ toolCallId: 'c9', state: 'output-available', input: { a: 1 } })
  })

  it('ignores a legacy tool event with no callId', async () => {
    const { message } = await assemble(encodeTurn([{ type: 'tool', name: 'x', summary: 's' }, text('ok')]))
    expect(visible(message)).toEqual([{ type: 'text', text: 'ok', state: 'done' }])
  })

  it('keeps reasoning and text as separate parts', async () => {
    const { message } = await assemble(encodeTurn([{ type: 'reasoning', text: 'hmm ' }, { type: 'reasoning', text: 'ok' }, text('Answer')]))
    expect(visible(message)).toEqual([
      { type: 'reasoning', text: 'hmm ok', state: 'done' },
      { type: 'text', text: 'Answer', state: 'done' }
    ])
  })

  it('reconciles subagent steps into ONE data part holding the latest list', async () => {
    const { message } = await assemble(encodeTurn([
      { type: 'tool-start', callId: 'c1', name: 'research_web', args: {} },
      { type: 'subagent', parentCallId: 'c1', steps: [{ callId: 'n1', name: 'web_search', state: 'running' }] },
      { type: 'subagent', parentCallId: 'c1', steps: [{ callId: 'n1', name: 'web_search', summary: 's', state: 'done' }] }
    ]))
    const data = message.parts.filter(p => p.type === 'data-subagent')
    expect(data).toEqual([{ type: 'data-subagent', id: 'c1', data: { steps: [{ callId: 'n1', name: 'web_search', summary: 's', state: 'done' }] } }])
  })

  it('lets a later usage supersede an earlier one', async () => {
    const { message } = await assemble(encodeTurn([
      { type: 'usage', inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      text('x'),
      { type: 'usage', inputTokens: 5, outputTokens: 5, totalTokens: 10 }
    ]))
    expect(message.metadata?.usage).toEqual({ inputTokens: 5, outputTokens: 5, totalTokens: 10 })
    expect(message.parts.some(p => p.type.startsWith('data-'))).toBe(false)
  })

  it('appends image-embed text that arrives after state:idle into the same message', async () => {
    const { message } = await assemble(encodeTurn([text('Here.'), { type: 'state', state: 'idle' }, text('\n\n![a cat](/api/images/i1/raw)')]))
    expect(visible(message)).toEqual([{ type: 'text', text: 'Here.\n\n![a cat](/api/images/i1/raw)', state: 'done' }])
  })

  it('ignores user transcripts, state and audio', () => {
    const enc = createUIChunkEncoder('m1')
    expect(enc.encode({ type: 'transcript', role: 'user', text: 'hi' })).toEqual([])
    expect(enc.encode({ type: 'state', state: 'thinking' })).toEqual([])
    expect(enc.encode({ type: 'audio-begin', segmentId: 1, sampleRate: 24000 })).toEqual([])
    expect(enc.encode({ type: 'audio', bytes: new Uint8Array([1]) })).toEqual([])
    expect(enc.encode({ type: 'audio-end', segmentId: 1 })).toEqual([])
  })

  it('an error ending keeps the partial text and reports the error', async () => {
    const { message, errors } = await assemble(encodeTurn([text('partial')], 'error'))
    expect(visible(message)).toEqual([{ type: 'text', text: 'partial', state: 'done' }])
    expect(errors).toEqual(['Error: boom'])
  })

  it('an abort ending keeps the partial text', async () => {
    const { message } = await assemble(encodeTurn([text('partial')], 'abort'))
    expect(visible(message)).toEqual([{ type: 'text', text: 'partial', state: 'done' }])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run server/lib/voice/ui-stream.test.ts`
Expected: FAIL — `Cannot find module './ui-stream'`.

- [ ] **Step 3: Implement** — `server/lib/voice/ui-stream.ts`

```ts
// Pure VoiceEvent → AI SDK UIMessageChunk encoder: one instance per assistant turn. The
// client assembles its output with the SDK's own readUIMessageStream, so the chunk sequence
// must be one that assembler accepts — ui-stream.test.ts proves each mapping against it.
import type { VoiceEvent } from './orchestrator'
import type { AgentUIChunk } from '../../../shared/types/agent-ui'
import { toolOutcome, toolEnvelope } from '../../../shared/utils/agent-ui'

export interface UIChunkEncoder {
  start(createdAt: string): AgentUIChunk[]
  encode(e: VoiceEvent): AgentUIChunk[]
  finish(): AgentUIChunk[]
  error(errorText: string): AgentUIChunk[]
  abort(): AgentUIChunk[]
}

export function createUIChunkEncoder(messageId: string): UIChunkEncoder {
  let open: { kind: 'text' | 'reasoning'; id: string } | null = null
  let seq = 0
  const started = new Set<string>()

  const close = (): AgentUIChunk[] => {
    if (!open) return []
    const chunk: AgentUIChunk = open.kind === 'text' ? { type: 'text-end', id: open.id } : { type: 'reasoning-end', id: open.id }
    open = null
    return [chunk]
  }
  const delta = (kind: 'text' | 'reasoning', value: string): AgentUIChunk[] => {
    const out = open?.kind === kind ? [] : close()
    if (!open) {
      open = { kind, id: `${messageId}-${kind}-${seq++}` }
      out.push(kind === 'text' ? { type: 'text-start', id: open.id } : { type: 'reasoning-start', id: open.id })
    }
    out.push(kind === 'text' ? { type: 'text-delta', id: open.id, delta: value } : { type: 'reasoning-delta', id: open.id, delta: value })
    return out
  }
  const input = (callId: string, name: string, args: Record<string, unknown>): AgentUIChunk[] => {
    started.add(callId)
    return [{ type: 'tool-input-available', toolCallId: callId, toolName: name, input: args, dynamic: true }]
  }

  return {
    start: createdAt => [{ type: 'start', messageId, messageMetadata: { createdAt } }, { type: 'start-step' }],

    encode(e) {
      switch (e.type) {
        case 'transcript':
          return e.role === 'assistant' && e.text ? delta('text', e.text) : []
        case 'reasoning':
          return e.text ? delta('reasoning', e.text) : []
        case 'tool-start':
          return [...close(), ...input(e.callId, e.name, e.args)]
        case 'tool': {
          if (!e.callId) return [] // legacy event without an id: cannot be paired, skip it
          const out = close()
          if (!started.has(e.callId)) out.push(...input(e.callId, e.name, e.args ?? {}))
          const outcome = toolOutcome(e.result)
          if (outcome.state === 'denied') out.push({ type: 'tool-output-denied', toolCallId: e.callId })
          else if (outcome.state === 'error') out.push({ type: 'tool-output-error', toolCallId: e.callId, errorText: outcome.errorText, dynamic: true })
          else out.push({ type: 'tool-output-available', toolCallId: e.callId, output: toolEnvelope({ result: e.result, summary: e.summary, undoToken: e.undoToken, kind: e.kind }), dynamic: true })
          return out
        }
        case 'subagent':
          return [{ type: 'data-subagent', id: e.parentCallId, data: { steps: e.steps } }]
        case 'usage':
          return [{ type: 'message-metadata', messageMetadata: { usage: { inputTokens: e.inputTokens, outputTokens: e.outputTokens, totalTokens: e.totalTokens } } }]
        default:
          return []
      }
    },

    finish: () => [...close(), { type: 'finish-step' }, { type: 'finish' }],
    error: errorText => [...close(), { type: 'error', errorText }],
    abort: () => [...close(), { type: 'abort' }]
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run server/lib/voice/ui-stream.test.ts && pnpm typecheck`
Expected: PASS. If `usage` metadata assertions fail because `undefined` fields survive (`{ inputTokens: undefined, … }`), build the usage object with only defined fields.

- [ ] **Step 5: Mutation check (do not commit the mutation)**

Temporarily change `delta`'s `open?.kind === kind ? [] : close()` to `close()` (text re-opened on every delta) — confirm "interleaves text…" and "appends image-embed text…" go red; revert. Temporarily swap the `denied`/`error` branches — confirm the two outcome tests go red; revert.

- [ ] **Step 6: Commit**

```bash
git add server/lib/voice/ui-stream.ts server/lib/voice/ui-stream.test.ts
git commit -m "feat(voice): encode agent turns as AI SDK UIMessage chunks"
```

---

### Task 6: The per-turn frame writer, wired into the voice socket

**Files:**
- Create: `server/lib/voice/turn-stream.ts`, `server/lib/voice/turn-stream.test.ts`
- Modify: `server/api/voice/ws.ts`

**Interfaces:**
- Consumes: `createUIChunkEncoder` (Task 5), `attachmentToFilePart` (Task 1), `AgentMessageFrame` (Task 1).
- Produces:

```ts
export interface TurnStream {
  emit(e: VoiceEvent): void   // pass (wrapped) as handleTurn/handleUtterance's `emit`
  finish(): void
  error(message: string): void
  abort(): void
}
export interface TurnStreamOptions {
  turnId: number
  send: (data: string | Uint8Array) => void
  attachments?: AttachmentRef[]
  now?: () => Date
  newId?: () => string
}
export function createTurnStream(o: TurnStreamOptions): TurnStream
```

Wire contract (server → client), replacing the `transcript`/`reasoning`/`tool`/`usage` frames:
- `{ type: 'user-message', turnId, message: AgentUIMessage }` — on the user `transcript` event.
- `{ type: 'chunk', turnId, chunk: AgentUIChunk }` — message chunks; the `start` chunk is sent lazily with the first message-bearing event, so a turn with no assistant output sends no chunks at all.
- `{ type: 'audio-begin', turnId, segmentId, sampleRate }` — `audio-begin` gains `turnId`.
- Unchanged passthrough: binary PCM, `audio-end`, `state`.
- `error()` sends the error chunk (if started) **and** the legacy `{type:'error', message}` + `{type:'state', state:'idle'}` frames (moved here from `ws.ts`).
- After `finish`/`error`/`abort`, every later `emit` is ignored.

- [ ] **Step 1: Write the failing tests** — `server/lib/voice/turn-stream.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { readUIMessageStream } from 'ai'
import { createTurnStream } from './turn-stream'
import type { AgentMessageFrame, AgentUIChunk, AgentUIMessage } from '../../../shared/types/agent-ui'

function harness(attachments?: Parameters<typeof createTurnStream>[0]['attachments']) {
  const frames: (Record<string, unknown> | Uint8Array)[] = []
  let n = 0
  const ts = createTurnStream({
    turnId: 7, attachments,
    send: d => frames.push(typeof d === 'string' ? JSON.parse(d) : d),
    now: () => new Date('2026-09-19T00:00:00.000Z'),
    newId: () => `id${n++}`
  })
  const json = () => frames.filter((f): f is Record<string, unknown> => !(f instanceof Uint8Array))
  const chunks = () => json().filter(f => f.type === 'chunk').map(f => (f as AgentMessageFrame & { type: 'chunk' }).chunk)
  return { ts, frames, json, chunks }
}

async function assemble(chunks: AgentUIChunk[]) {
  const stream = new ReadableStream<AgentUIChunk>({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close() } })
  let m: AgentUIMessage | undefined
  for await (const x of readUIMessageStream<AgentUIMessage>({ stream, onError: () => {} })) m = x
  return m!
}

describe('createTurnStream', () => {
  it('sends the user turn as a user-message with file parts and metadata.attachments', () => {
    const att = [{ id: 'i1', kind: 'image' as const, mime: 'image/png' }]
    const h = harness(att)
    h.ts.emit({ type: 'transcript', role: 'user', text: 'look' })
    expect(h.json()).toEqual([{
      type: 'user-message', turnId: 7,
      message: {
        id: 'id1', role: 'user',
        parts: [{ type: 'text', text: 'look' }, { type: 'file', mediaType: 'image/png', url: '/api/images/i1/raw' }],
        metadata: { createdAt: '2026-09-19T00:00:00.000Z', attachments: att }
      }
    }])
  })

  it('stamps every chunk with the turnId and starts the message lazily', async () => {
    const h = harness()
    h.ts.emit({ type: 'state', state: 'thinking' })
    expect(h.chunks()).toEqual([])
    h.ts.emit({ type: 'transcript', role: 'assistant', text: 'hi' })
    h.ts.finish()
    expect(h.json().filter(f => f.type === 'chunk').every(f => f.turnId === 7)).toBe(true)
    const m = await assemble(h.chunks())
    expect(m.parts.filter(p => p.type === 'text')).toEqual([{ type: 'text', text: 'hi', state: 'done' }])
  })

  it('sends no chunks at all for a turn with no assistant output', () => {
    const h = harness()
    h.ts.emit({ type: 'transcript', role: 'user', text: 'hi' })
    h.ts.finish()
    expect(h.chunks()).toEqual([])
  })

  it('adds turnId to audio-begin and passes PCM, audio-end and state through', () => {
    const h = harness()
    const pcm = new Uint8Array([1, 2])
    h.ts.emit({ type: 'audio-begin', segmentId: 1, sampleRate: 24000 })
    h.ts.emit({ type: 'audio', bytes: pcm })
    h.ts.emit({ type: 'audio-end', segmentId: 1 })
    h.ts.emit({ type: 'state', state: 'speaking' })
    expect(h.frames).toEqual([
      { type: 'audio-begin', segmentId: 1, sampleRate: 24000, turnId: 7 },
      pcm,
      { type: 'audio-end', segmentId: 1 },
      { type: 'state', state: 'speaking' }
    ])
  })

  it('lands text emitted after state:idle (the image-embed append) before finish', async () => {
    const h = harness()
    h.ts.emit({ type: 'transcript', role: 'assistant', text: 'Here.' })
    h.ts.emit({ type: 'state', state: 'idle' })
    h.ts.emit({ type: 'transcript', role: 'assistant', text: '\n\n![c](/api/images/i1/raw)' })
    h.ts.finish()
    const m = await assemble(h.chunks())
    expect(m.parts.find(p => p.type === 'text')).toMatchObject({ text: 'Here.\n\n![c](/api/images/i1/raw)' })
  })

  it('error: error chunk, then the legacy error + idle frames, then silence', () => {
    const h = harness()
    h.ts.emit({ type: 'transcript', role: 'assistant', text: 'part' })
    h.ts.error('model down')
    h.ts.emit({ type: 'transcript', role: 'assistant', text: 'late' })
    const tail = h.json().slice(-3)
    expect(tail[0]).toMatchObject({ type: 'chunk', chunk: { type: 'error', errorText: 'model down' } })
    expect(tail.slice(1)).toEqual([{ type: 'error', message: 'model down' }, { type: 'state', state: 'idle' }])
    expect(JSON.stringify(h.json())).not.toContain('late')
  })

  it('abort: an abort chunk, then silence', () => {
    const h = harness()
    h.ts.emit({ type: 'transcript', role: 'assistant', text: 'part' })
    h.ts.abort()
    h.ts.emit({ type: 'transcript', role: 'assistant', text: 'late' })
    h.ts.finish()
    expect(h.chunks().at(-1)).toEqual({ type: 'abort' })
    expect(JSON.stringify(h.json())).not.toContain('late')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run server/lib/voice/turn-stream.test.ts`
Expected: FAIL — `Cannot find module './turn-stream'`.

- [ ] **Step 3: Implement** — `server/lib/voice/turn-stream.ts`

```ts
// One turn's frames on the voice socket. Owns the emission-ORDER rules so ws.ts stays thin
// and so they are testable without a crossws harness:
//   - every message frame carries the turn's id (the client drops a superseded turn's frames);
//   - `finish` is sent only after handleTurn returns — the orchestrator appends image embeds
//     AFTER the speech pipeline drains, and those must land inside the message;
//   - nothing is sent after finish/error/abort.
import { randomUUID } from 'node:crypto'
import type { VoiceEvent } from './orchestrator'
import { createUIChunkEncoder } from './ui-stream'
import type { AgentMessageFrame, AgentUIChunk, AgentUIMessage } from '../../../shared/types/agent-ui'
import type { AttachmentRef } from '../../../shared/types/conversation'
import { attachmentToFilePart } from '../../../shared/utils/agent-ui'

export interface TurnStream {
  emit(e: VoiceEvent): void
  finish(): void
  error(message: string): void
  abort(): void
}

export interface TurnStreamOptions {
  turnId: number
  send: (data: string | Uint8Array) => void
  attachments?: AttachmentRef[]
  now?: () => Date
  newId?: () => string
}

export function createTurnStream(o: TurnStreamOptions): TurnStream {
  const now = o.now ?? (() => new Date())
  const newId = o.newId ?? randomUUID
  const encoder = createUIChunkEncoder(newId())
  let started = false
  let closed = false

  const json = (frame: unknown) => o.send(JSON.stringify(frame))
  const sendChunks = (chunks: AgentUIChunk[]) => {
    for (const chunk of chunks) json({ type: 'chunk', turnId: o.turnId, chunk } satisfies AgentMessageFrame)
  }

  return {
    emit(e) {
      if (closed) return
      switch (e.type) {
        case 'audio': o.send(e.bytes); return
        case 'audio-begin': json({ ...e, turnId: o.turnId }); return
        case 'audio-end':
        case 'state': json(e); return
        case 'transcript':
          if (e.role === 'user') {
            const attachments = o.attachments ?? []
            const message: AgentUIMessage = {
              id: newId(),
              role: 'user',
              parts: [{ type: 'text', text: e.text }, ...attachments.map(attachmentToFilePart)],
              metadata: { createdAt: now().toISOString(), ...(attachments.length ? { attachments } : {}) }
            }
            json({ type: 'user-message', turnId: o.turnId, message } satisfies AgentMessageFrame)
            return
          }
          break
      }
      const chunks = encoder.encode(e)
      if (!chunks.length) return
      if (!started) { started = true; sendChunks(encoder.start(now().toISOString())) }
      sendChunks(chunks)
    },
    finish() {
      if (closed) return
      closed = true
      if (started) sendChunks(encoder.finish())
    },
    error(message) {
      if (closed) return
      closed = true
      if (started) sendChunks(encoder.error(message))
      json({ type: 'error', message })
      json({ type: 'state', state: 'idle' })
    },
    abort() {
      if (closed) return
      closed = true
      if (started) sendChunks(encoder.abort())
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run server/lib/voice/turn-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `server/api/voice/ws.ts`**

1. Import: `import { createTurnStream } from '../../lib/voice/turn-stream'`.
2. `ConnState` gains `turnSeq: number`; `open()` initializes it to `0`.
3. Update the header comment's Server→client block to list: binary PCM; `audio-begin {turnId,segmentId,sampleRate}` / `audio-end`; `state`; `chunk {turnId, chunk: UIMessageChunk}`; `user-message {turnId, message}`; `approval*`; `conversation`; `error`.
4. Just before `s.ac?.abort()` (after `turn` is decided), add `const turnId = ++s.turnSeq` and `const attachmentsForTurn = turnAttachments`.
5. In `run()`, replace the `emit` definition and the exec/catch handling:

```ts
        const ts = createTurnStream({ turnId, attachments: attachmentsForTurn, send: d => peer.send(d) })
        const emit = (e: VoiceEvent) => {
          if (e.type === 'reasoning') reasoningText += e.text
          // Overwrite, not accumulate: at most one usage event per turn in the common
          // case, and if the rare forced-final recovery path (run.ts) yields a second
          // one, it's from the streamText call that actually produced the visible text —
          // that supersedes the aborted first call's usage rather than adding to it.
          else if (e.type === 'usage') turnUsage = { inputTokens: e.inputTokens, outputTokens: e.outputTokens, totalTokens: e.totalTokens }
          ts.emit(e)
        }
        s.history = await exec!(ac.signal, emit, context)
        // Close the message BEFORE persisting: the UI should finish promptly; persistence
        // (and the `conversation` frame for a new thread) follows.
        if (ac.signal.aborted) ts.abort()
        else ts.finish()
```

   and the catch becomes:

```ts
      } catch (err) {
        if ((err as Error).name === 'AbortError') { turnStream?.abort(); return }
        console.error('[agent] turn failed:', err)
        if (turnStream) turnStream.error((err as Error).message || 'agent pipeline error')
        else {
          peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'agent pipeline error' }))
          peer.send(JSON.stringify({ type: 'state', state: 'idle' }))
        }
      }
```

   To make `turnStream` visible in the catch, declare `let turnStream: ReturnType<typeof createTurnStream> | null = null` at the top of `run` (before `try`) and assign `turnStream = ts` right after creating it. (`buildLiveContext` runs before the stream exists, so an error there still gets the legacy frames.)

- [ ] **Step 6: Gates**

Run: `pnpm typecheck && pnpm vitest run server/ test/`
Expected: PASS. (The client still reads the old frames until Task 10 — `/agent` is expected to be broken in the browser between Tasks 6 and 10; do not browser-test in between.)

- [ ] **Step 7: Commit**

```bash
git add server/lib/voice/turn-stream.ts server/lib/voice/turn-stream.test.ts server/api/voice/ws.ts
git commit -m "feat(voice): stream turns to the client as turnId-stamped UIMessage chunks"
```

---

### Task 7: Client turn assembly (and stale-turn audio)

**Files:**
- Create: `app/lib/agent/turn-stream.ts`, `app/lib/agent/turn-stream.test.ts`
- Modify: `app/lib/voice/playback-epoch.ts`, `app/lib/voice/playback-epoch.test.ts`

**Interfaces:**
- Consumes: `AgentMessageFrame`, `AgentUIMessage`, `AgentUIChunk` (Task 1).
- Produces:

```ts
export function finalizeMessage(m: AgentUIMessage, meta: { interrupted?: true; errorText?: string }): AgentUIMessage
export interface ClientTurns {
  handle(frame: AgentMessageFrame): void
  isStale(turnId: number): boolean
  interrupt(): void    // the user stopped / barged in: close the current turn, drop its later frames
  disconnect(): void   // socket closed: close the current turn with errorText 'Connection lost'
  reset(): void        // (re)connected: turn ids restart at 1 on a new socket
  settled(): Promise<void> // resolves when the latest turn's assembly has finished (tests)
}
export function createClientTurns(o: { upsert: (m: AgentUIMessage) => void }): ClientTurns
```

- `playback-epoch.ts`: `PlaybackEpochs.rejectSegment(): void` — marks the opening segment as never-acceptable.

- [ ] **Step 1: Write the failing tests**

`app/lib/agent/turn-stream.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createClientTurns, finalizeMessage } from './turn-stream'
import type { AgentMessageFrame, AgentUIChunk, AgentUIMessage } from '~~/shared/types/agent-ui'

function harness() {
  const messages: AgentUIMessage[] = []
  const turns = createClientTurns({
    upsert: (m) => {
      const i = messages.findIndex(x => x.id === m.id)
      if (i >= 0) messages[i] = m
      else messages.push(m)
    }
  })
  const chunk = (turnId: number, c: AgentUIChunk) => turns.handle({ type: 'chunk', turnId, chunk: c })
  const user = (turnId: number, id: string, text: string) =>
    turns.handle({ type: 'user-message', turnId, message: { id, role: 'user', parts: [{ type: 'text', text }] } } as AgentMessageFrame)
  const begin = (turnId: number, id: string) => { chunk(turnId, { type: 'start', messageId: id }); chunk(turnId, { type: 'text-start', id: `${id}-t` }) }
  const say = (turnId: number, id: string, t: string) => chunk(turnId, { type: 'text-delta', id: `${id}-t`, delta: t })
  const end = (turnId: number, id: string) => { chunk(turnId, { type: 'text-end', id: `${id}-t` }); chunk(turnId, { type: 'finish' }) }
  const textOf = (id: string) => messages.find(m => m.id === id)?.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('')
  return { messages, turns, chunk, user, begin, say, end, textOf }
}

describe('createClientTurns', () => {
  it('upserts the user message and assembles the assistant message', async () => {
    const h = harness()
    h.user(1, 'u1', 'hi'); h.begin(1, 'a1'); h.say(1, 'a1', 'Hel'); h.say(1, 'a1', 'lo'); h.end(1, 'a1')
    await h.turns.settled()
    expect(h.messages.map(m => m.id)).toEqual(['u1', 'a1'])
    expect(h.textOf('a1')).toBe('Hello')
    expect(h.messages[1]!.parts.find(p => p.type === 'text')).toMatchObject({ state: 'done' })
  })

  it('drops frames from an older turn', async () => {
    const h = harness()
    h.user(2, 'u2', 'second')
    h.begin(1, 'old'); h.say(1, 'old', 'stale'); h.end(1, 'old')
    await h.turns.settled()
    expect(h.messages.map(m => m.id)).toEqual(['u2'])
  })

  it('a newer turn supersedes the active one: interrupted, dangling tool stopped', async () => {
    const h = harness()
    h.user(1, 'u1', 'go'); h.chunk(1, { type: 'start', messageId: 'a1' })
    h.chunk(1, { type: 'tool-input-available', toolCallId: 'c1', toolName: 'web_fetch', input: {}, dynamic: true })
    await new Promise(r => setTimeout(r, 0))
    h.user(2, 'u2', 'never mind')
    await h.turns.settled()
    const a1 = h.messages.find(m => m.id === 'a1')!
    expect(a1.metadata?.interrupted).toBe(true)
    expect(a1.parts.find(p => p.type === 'dynamic-tool')).toMatchObject({ state: 'output-error', errorText: 'Stopped' })
    expect(h.messages.at(-1)!.id).toBe('u2')
  })

  it('interrupt() closes the turn and ignores its later frames', async () => {
    const h = harness()
    h.user(1, 'u1', 'go'); h.begin(1, 'a1'); h.say(1, 'a1', 'par')
    h.turns.interrupt()
    h.say(1, 'a1', 'tial')
    await h.turns.settled()
    expect(h.textOf('a1')).toBe('par')
    expect(h.messages.find(m => m.id === 'a1')!.metadata?.interrupted).toBe(true)
  })

  it('interrupt() before any chunk still drops that turn', async () => {
    const h = harness()
    h.user(1, 'u1', 'go')
    h.turns.interrupt()
    h.begin(1, 'a1'); h.say(1, 'a1', 'late'); h.end(1, 'a1')
    await h.turns.settled()
    expect(h.messages.map(m => m.id)).toEqual(['u1'])
  })

  it('an error chunk keeps the partial text and records errorText', async () => {
    const h = harness()
    h.begin(1, 'a1'); h.say(1, 'a1', 'partial')
    h.chunk(1, { type: 'text-end', id: 'a1-t' }); h.chunk(1, { type: 'error', errorText: 'boom' })
    await h.turns.settled()
    const a1 = h.messages.find(m => m.id === 'a1')!
    expect(h.textOf('a1')).toBe('partial')
    expect(a1.metadata?.errorText).toBe('boom')
  })

  it('an abort chunk marks the message interrupted', async () => {
    const h = harness()
    h.begin(1, 'a1'); h.say(1, 'a1', 'x'); h.chunk(1, { type: 'abort' })
    await h.turns.settled()
    expect(h.messages.find(m => m.id === 'a1')!.metadata?.interrupted).toBe(true)
  })

  it('disconnect() closes the active turn as Connection lost', async () => {
    const h = harness()
    h.begin(1, 'a1'); h.say(1, 'a1', 'x')
    h.turns.disconnect()
    await h.turns.settled()
    expect(h.messages.find(m => m.id === 'a1')!.metadata?.errorText).toBe('Connection lost')
  })

  it('reset() restarts turn numbering for a new socket', async () => {
    const h = harness()
    h.user(3, 'u3', 'before reconnect')
    h.turns.reset()
    h.user(1, 'u1b', 'after reconnect')
    await h.turns.settled()
    expect(h.messages.map(m => m.id)).toEqual(['u3', 'u1b'])
  })

  it('isStale reports older and closed turns', () => {
    const h = harness()
    h.user(2, 'u2', 'x')
    expect(h.turns.isStale(1)).toBe(true)
    expect(h.turns.isStale(2)).toBe(false)
    h.turns.interrupt()
    expect(h.turns.isStale(2)).toBe(true)
  })
})

describe('finalizeMessage', () => {
  it('stops everything still in flight and merges the metadata', () => {
    const m: AgentUIMessage = {
      id: 'a', role: 'assistant', metadata: { createdAt: 't' },
      parts: [
        { type: 'reasoning', text: 'r', state: 'streaming' },
        { type: 'text', text: 'x', state: 'streaming' },
        { type: 'dynamic-tool', toolName: 't', toolCallId: 'c', state: 'input-streaming', input: undefined },
        { type: 'dynamic-tool', toolName: 't', toolCallId: 'd', state: 'output-available', input: {}, output: { value: 1, summary: 's' } },
        { type: 'data-subagent', id: 'c', data: { steps: [{ callId: 'n', name: 'w', state: 'running' }] } }
      ]
    }
    const f = finalizeMessage(m, { interrupted: true })
    expect(f.metadata).toEqual({ createdAt: 't', interrupted: true })
    expect(f.parts.map(p => ('state' in p ? p.state : (p as { data: { steps: { state: string }[] } }).data.steps[0]!.state)))
      .toEqual(['done', 'done', 'output-error', 'output-available', 'error'])
    expect(f.parts[2]).toMatchObject({ errorText: 'Stopped' })
  })
})
```

Append to `app/lib/voice/playback-epoch.test.ts`:

```ts
describe('rejectSegment', () => {
  it('makes the segment being opened unacceptable until the next beginSegment', () => {
    const e = createPlaybackEpochs()
    e.rejectSegment()
    expect(e.accepts(e.segment())).toBe(false)
    e.beginSegment()
    expect(e.accepts(e.segment())).toBe(true)
  })
})
```

(Add `describe` to that file's vitest import if it is not already there.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run app/lib/agent/turn-stream.test.ts app/lib/voice/playback-epoch.test.ts`
Expected: FAIL — missing module / `rejectSegment is not a function`.

- [ ] **Step 3: Implement**

`app/lib/voice/playback-epoch.ts` — add to the interface and the factory:

```ts
  /** The opening segment belongs to a superseded turn (its `audio-begin` carried a stale
   *  turnId): stamp it so none of its frames are ever accepted. */
  rejectSegment: () => void
```

```ts
    rejectSegment() { segmentEpoch = -1 },
```

`app/lib/agent/turn-stream.ts`:

```ts
// Client side of the message protocol: one readUIMessageStream per turn, fed by the WS
// `chunk` frames of that turn. Turn ids are monotonic per socket, so "stale" is simply
// "older than the newest turn seen" or "a turn we closed ourselves" (Stop / barge-in).
// Pure (no Vue, no WebSocket) so the ordering rules are unit-testable.
import { readUIMessageStream } from 'ai'
import type { AgentMessageFrame, AgentUIChunk, AgentUIMessage, AgentUIPart } from '~~/shared/types/agent-ui'

type CloseMeta = { interrupted?: true; errorText?: string }

/** Close out a message whose stream ended: nothing may keep spinning after its turn. */
export function finalizeMessage(m: AgentUIMessage, meta: CloseMeta): AgentUIMessage {
  return {
    ...m,
    metadata: { ...m.metadata, ...meta },
    parts: m.parts.map((p): AgentUIPart => {
      if (p.type === 'dynamic-tool' && (p.state === 'input-streaming' || p.state === 'input-available')) {
        return { type: 'dynamic-tool', toolName: p.toolName, toolCallId: p.toolCallId, state: 'output-error', input: p.input, errorText: 'Stopped' }
      }
      if ((p.type === 'text' || p.type === 'reasoning') && p.state === 'streaming') return { ...p, state: 'done' }
      if (p.type === 'data-subagent') {
        return { ...p, data: { steps: p.data.steps.map(s => (s.state === 'running' ? { ...s, state: 'error' as const } : s)) } }
      }
      return p
    })
  }
}

export interface ClientTurns {
  handle(frame: AgentMessageFrame): void
  isStale(turnId: number): boolean
  interrupt(): void
  disconnect(): void
  reset(): void
  settled(): Promise<void>
}

interface ActiveTurn {
  turnId: number
  controller: ReadableStreamDefaultController<AgentUIChunk>
  meta: CloseMeta
  done: Promise<void>
}

export function createClientTurns(o: { upsert: (m: AgentUIMessage) => void }): ClientTurns {
  let current = 0
  const closed = new Set<number>()
  let active: ActiveTurn | null = null
  let lastDone: Promise<void> = Promise.resolve()

  function open(turnId: number): ActiveTurn {
    let controller!: ReadableStreamDefaultController<AgentUIChunk>
    const stream = new ReadableStream<AgentUIChunk>({ start(c) { controller = c } })
    const turn: ActiveTurn = { turnId, controller, meta: {}, done: Promise.resolve() }
    turn.done = (async () => {
      let last: AgentUIMessage | undefined
      try {
        // onError: an `error` chunk is reported here, not thrown; the meta already has its text.
        for await (const m of readUIMessageStream<AgentUIMessage>({ stream, onError: () => {} })) {
          last = m
          o.upsert(m)
        }
      } catch { /* the assembler rejected the stream — finalize what we have */ }
      if (last) o.upsert(finalizeMessage(last, turn.meta))
    })()
    lastDone = turn.done
    active = turn
    return turn
  }

  function close(meta: CloseMeta) {
    if (!active) return
    Object.assign(active.meta, meta)
    closed.add(active.turnId)
    try { active.controller.close() } catch { /* already closed */ }
    active = null
  }

  /** Accept a frame's turn (switching to it if newer). False = drop the frame. */
  function advance(turnId: number): boolean {
    if (turnId < current || closed.has(turnId)) return false
    if (turnId > current) {
      if (active) close({ interrupted: true })
      current = turnId
    }
    return true
  }

  return {
    handle(frame) {
      if (!advance(frame.turnId)) return
      if (frame.type === 'user-message') { o.upsert(frame.message); return }
      const turn = active?.turnId === frame.turnId ? active : open(frame.turnId)
      const c = frame.chunk
      turn.controller.enqueue(c)
      if (c.type === 'finish') close({})
      else if (c.type === 'abort') close({ interrupted: true })
      else if (c.type === 'error') close({ errorText: c.errorText })
    },
    isStale: turnId => turnId < current || closed.has(turnId),
    interrupt() {
      if (active) close({ interrupted: true })
      else if (current) closed.add(current)
    },
    disconnect() { close({ errorText: 'Connection lost' }) },
    reset() {
      close({ errorText: 'Connection lost' })
      current = 0
      closed.clear()
    },
    settled: () => lastDone
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run app/lib/agent/turn-stream.test.ts app/lib/voice/playback-epoch.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Mutation check (do not commit)**

Change `turnId < current` to `turnId < current - 1` in `advance` → "drops frames from an older turn" goes red; revert. Remove the `if (p.type === 'dynamic-tool' …)` branch in `finalizeMessage` → the supersede test goes red; revert.

- [ ] **Step 6: Commit**

```bash
git add app/lib/agent/turn-stream.ts app/lib/agent/turn-stream.test.ts app/lib/voice/playback-epoch.ts app/lib/voice/playback-epoch.test.ts
git commit -m "feat(agent-ui): assemble each turn with readUIMessageStream; drop stale turns"
```

---

### Task 8: Resume into UIMessages, and the live↔resume parity guard

**Files:**
- Create: `app/lib/agent/to-ui-messages.ts`, `app/lib/agent/to-ui-messages.test.ts`, `test/agent-ui-parity.test.ts`

**Interfaces:**
- Consumes: `ConversationMessageDTO` / `ToolCallRecordDTO` (incl. `steps`, Task 1), `toolOutcome` / `toolEnvelope` / `attachmentToFilePart` (Task 1). The parity test also consumes `handleTurn` (Task 4), `createTurnStream` (Task 6), `createClientTurns` (Task 7), `buildTurnPersistPayload` (existing).
- Produces:

```ts
export type ResumeMessage = Pick<ConversationMessageDTO, 'id' | 'role' | 'content'>
  & Partial<Pick<ConversationMessageDTO, 'toolCalls' | 'reasoning' | 'attachments' | 'usage' | 'createdAt'>>
export function toUIMessages(messages: ResumeMessage[]): AgentUIMessage[]
```

- [ ] **Step 1: Write the failing tests** — `app/lib/agent/to-ui-messages.test.ts`

(Ports every case of `app/lib/agent/transcript.test.ts` to the one-message-with-parts model.)

```ts
import { describe, it, expect } from 'vitest'
import { toUIMessages, type ResumeMessage } from './to-ui-messages'
import { applyImageEmbeds, sanitizedOffset } from '../../../server/lib/agent/image-embed'
import type { AgentUIMessage } from '~~/shared/types/agent-ui'

type ToolCall = NonNullable<ResumeMessage['toolCalls']>[number]
const tc = (o: Partial<ToolCall> = {}): ToolCall => ({ name: 'web_search', summary: 'searched', callId: 'c1', textOffset: 0, args: { q: 'a' }, result: { hits: 1 }, kind: 'read', ...o })
const msg = (o: Partial<ResumeMessage> = {}): ResumeMessage => ({ id: 'm1', role: 'assistant', content: 'hello', ...o })
const shape = (m: AgentUIMessage) => m.parts.map(p => p.type === 'text' ? ['text', p.text] : p.type === 'dynamic-tool' ? ['tool', p.toolCallId] : [p.type])

describe('toUIMessages', () => {
  it('interleaves text → tool → text at each offset, in ONE message', () => {
    const [m] = toUIMessages([msg({ content: 'Looking. Found it.', toolCalls: [tc({ textOffset: 'Looking. '.length })] })])
    expect(shape(m!)).toEqual([['text', 'Looking. '], ['tool', 'c1'], ['text', 'Found it.']])
    expect(m!.parts[1]).toEqual({
      type: 'dynamic-tool', toolName: 'web_search', toolCallId: 'c1', state: 'output-available', input: { q: 'a' },
      output: { value: { hits: 1 }, summary: 'searched', kind: 'read' }
    })
  })

  it('a server-recorded offset splits the persisted content on a word boundary', () => {
    const before = '\nOkay. '
    const { content } = applyImageEmbeds(before + ' Done.', [])
    expect(content).toBe('Okay. Done.')
    const [good] = toUIMessages([msg({ content, toolCalls: [tc({ textOffset: sanitizedOffset(before) })] })])
    expect(shape(good!)).toEqual([['text', 'Okay. '], ['tool', 'c1'], ['text', 'Done.']])
  })

  it('falls back to tools-first for a legacy row with no offsets', () => {
    const [m] = toUIMessages([msg({ content: 'done', toolCalls: [{ name: 'x', summary: 's', undoToken: 'u' }] })])
    expect(shape(m!)).toEqual([['tool', 'm1-tool-0'], ['text', 'done']])
    expect(m!.parts[0]).toMatchObject({ output: { undoToken: 'u' }, input: {} })
  })

  it('falls back — without dropping any record — when offsets are MIXED', () => {
    const [m] = toUIMessages([msg({ content: 'done', toolCalls: [tc({ textOffset: 2 }), { name: 'legacy', summary: 's' }] })])
    expect(shape(m!)).toEqual([['tool', 'c1'], ['tool', 'm1-tool-1'], ['text', 'done']])
  })

  it('leaves no empty trailing text when the tool ends the reply', () => {
    const [m] = toUIMessages([msg({ content: 'All set.', toolCalls: [tc({ textOffset: 8 })] })])
    expect(shape(m!)).toEqual([['text', 'All set.'], ['tool', 'c1']])
  })

  it('puts persisted reasoning first and carries usage/createdAt as metadata', () => {
    const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
    const [m] = toUIMessages([msg({ content: 'hey', reasoning: 'hmm', usage, createdAt: '2026-01-01T00:00:00.000Z' })])
    expect(m!.parts[0]).toEqual({ type: 'reasoning', text: 'hmm', state: 'done' })
    expect(m!.metadata).toEqual({ createdAt: '2026-01-01T00:00:00.000Z', usage })
  })

  it('clamps out-of-range and negative offsets', () => {
    const [m] = toUIMessages([msg({ content: 'abcdefghij', toolCalls: [tc({ callId: 'a', textOffset: -5 }), tc({ callId: 'b', textOffset: 9999 })] })])
    expect(shape(m!)).toEqual([['tool', 'a'], ['text', 'abcdefghij'], ['tool', 'b']])
  })

  it('never duplicates or loses text when a later offset is smaller (non-monotonic sanitizedOffset)', () => {
    const [m] = toUIMessages([msg({ content: 'abcdefghij', toolCalls: [tc({ callId: 'c1', textOffset: 6 }), tc({ callId: 'c2', textOffset: 2 })] })])
    expect(m!.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('')).toBe('abcdefghij')
    expect(m!.parts.filter(p => p.type === 'dynamic-tool')).toHaveLength(2)
  })

  it('maps error and denied results to their tool states', () => {
    const [m] = toUIMessages([msg({ content: '', toolCalls: [tc({ callId: 'e', result: { error: '403' } }), tc({ callId: 'd', result: { denied: true } })] })])
    expect(m!.parts[0]).toMatchObject({ state: 'output-error', errorText: '403' })
    expect(m!.parts[1]).toMatchObject({ state: 'output-denied', approval: { id: 'd', approved: false } })
  })

  it('adds a subagent data part right after its tool', () => {
    const steps = [{ callId: 'n1', name: 'web_search', summary: 's', state: 'done' as const }]
    const [m] = toUIMessages([msg({ content: 'x', toolCalls: [tc({ textOffset: 0, steps })] })])
    expect(m!.parts.slice(0, 2)).toEqual([
      expect.objectContaining({ type: 'dynamic-tool', toolCallId: 'c1' }),
      { type: 'data-subagent', id: 'c1', data: { steps } }
    ])
  })

  it('user turns get text + file parts and metadata.attachments', () => {
    const attachments = [{ id: 'i1', kind: 'image' as const, mime: 'image/png' }]
    const [u] = toUIMessages([{ id: 'u1', role: 'user', content: 'look', attachments, toolCalls: null }])
    expect(u).toEqual({
      id: 'u1', role: 'user',
      parts: [{ type: 'text', text: 'look' }, { type: 'file', mediaType: 'image/png', url: '/api/images/i1/raw' }],
      metadata: { attachments }
    })
  })

  it('skips malformed (null) tool records instead of throwing', () => {
    const [m] = toUIMessages([msg({ content: 'ok', toolCalls: [null as never] })])
    expect(shape(m!)).toEqual([['text', 'ok']])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run app/lib/agent/to-ui-messages.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `app/lib/agent/to-ui-messages.ts`

```ts
// Persisted conversation messages → AgentUIMessage[], for resume. One persisted assistant row
// is ONE message whose parts interleave text and tools at each record's textOffset — the
// offset is recorded server-side against the SANITIZED text (image-embed.ts sanitizedOffset),
// so slicing the persisted content at it reproduces the live stream's order.
import type { ConversationMessageDTO, ToolCallRecordDTO } from '~~/shared/types/conversation'
import type { AgentUIMessage, AgentUIPart, AgentMessageMetadata } from '~~/shared/types/agent-ui'
import { toolOutcome, toolEnvelope, attachmentToFilePart } from '~~/shared/utils/agent-ui'

export type ResumeMessage = Pick<ConversationMessageDTO, 'id' | 'role' | 'content'>
  & Partial<Pick<ConversationMessageDTO, 'toolCalls' | 'reasoning' | 'attachments' | 'usage' | 'createdAt'>>

const textPart = (text: string): AgentUIPart => ({ type: 'text', text, state: 'done' })

function recordParts(m: ResumeMessage, t: ToolCallRecordDTO, i: number): AgentUIPart[] {
  const toolCallId = t.callId || `${m.id}-tool-${i}`
  const base = { type: 'dynamic-tool' as const, toolName: t.name, toolCallId, input: t.args ?? {} }
  const outcome = toolOutcome(t.result)
  const tool: AgentUIPart = outcome.state === 'denied'
    ? { ...base, state: 'output-denied', approval: { id: toolCallId, approved: false } }
    : outcome.state === 'error'
      ? { ...base, state: 'output-error', errorText: outcome.errorText }
      : { ...base, state: 'output-available', output: toolEnvelope({ result: t.result, summary: t.summary, undoToken: t.undoToken, kind: t.kind }) }
  return t.steps?.length
    ? [tool, { type: 'data-subagent', id: toolCallId, data: { steps: t.steps } }]
    : [tool]
}

export function toUIMessages(messages: ResumeMessage[]): AgentUIMessage[] {
  return messages.map((m): AgentUIMessage => {
    const metadata: AgentMessageMetadata = {
      ...(m.createdAt ? { createdAt: m.createdAt } : {}),
      ...(m.usage ? { usage: m.usage } : {})
    }
    if (m.role === 'user') {
      const attachments = m.attachments ?? []
      return {
        id: m.id,
        role: 'user',
        parts: [...(m.content ? [{ type: 'text' as const, text: m.content }] : []), ...attachments.map(attachmentToFilePart)],
        metadata: { ...metadata, ...(attachments.length ? { attachments } : {}) }
      }
    }

    const parts: AgentUIPart[] = m.reasoning ? [{ type: 'reasoning', text: m.reasoning, state: 'done' }] : []
    // Malformed jsonb (a null/primitive element) must not throw — same tolerance as rowToAgentMessage.
    const records = (m.toolCalls ?? []).filter((t): t is ToolCallRecordDTO => !!t && typeof t === 'object')
    // All-or-nothing: interleave only when EVERY record has an offset; otherwise legacy tools-first.
    const allOffset = records.length > 0 && records.every(t => typeof t.textOffset === 'number')
    if (!allOffset) {
      records.forEach((t, i) => parts.push(...recordParts(m, t, i)))
      if (m.content) parts.push(textPart(m.content))
    } else {
      let cursor = 0
      records.forEach((t, i) => {
        const at = Math.min(Math.max(t.textOffset!, 0), m.content.length)
        if (at > cursor) parts.push(textPart(m.content.slice(cursor, at)))
        parts.push(...recordParts(m, t, i))
        // Never walk backwards: sanitizedOffset is not monotonic.
        cursor = Math.max(cursor, at)
      })
      const trailing = m.content.slice(cursor)
      if (trailing) parts.push(textPart(trailing))
    }
    return { id: m.id, role: 'assistant', parts, metadata }
  })
}
```

Note the user text part has no `state` (matching what the server's `user-message` sends).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run app/lib/agent/to-ui-messages.test.ts`
Expected: PASS.

- [ ] **Step 5: The parity guard** — `test/agent-ui-parity.test.ts`

```ts
// Drift guard: the SAME turn, (a) streamed live through orchestrator → turn stream → client
// assembly, and (b) persisted → resumed through toUIMessages, must render the same parts.
// Reasoning is compared by content only: live it can interleave with tools, persisted it is
// one string (a documented asymmetry).
import { describe, it, expect } from 'vitest'
import { handleTurn, type VoiceEvent } from '../server/lib/voice/orchestrator'
import { createTurnStream } from '../server/lib/voice/turn-stream'
import { buildTurnPersistPayload } from '../server/lib/voice/turn-persist'
import { createClientTurns } from '../app/lib/agent/turn-stream'
import { toUIMessages, type ResumeMessage } from '../app/lib/agent/to-ui-messages'
import type { AgentEvent } from '../server/lib/agent/run'
import type { AgentMessageFrame, AgentUIMessage } from '../shared/types/agent-ui'
import type { VoicePresetDTO } from '../shared/types/voice-presets'

const preset: VoicePresetDTO = {
  id: 'p1', name: 'n', instruction: 'A calm man.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: null, refText: null, refDurationMs: null,
  maxSegmentChars: 200, calibratedRefKey: null, refSource: null, starredSeeds: [], isDefault: true
}

const agentEvents: AgentEvent[] = [
  { type: 'reasoning-delta', text: 'Check docs, then research.' },
  { type: 'text-delta', text: 'Looking. ' },
  { type: 'tool-start', name: 'search_docs', args: { q: 'orpheus' }, callId: 'c1' },
  { type: 'tool-result', name: 'search_docs', summary: 'found 2', callId: 'c1', args: { q: 'orpheus' }, result: { hits: 2 }, kind: 'read' },
  { type: 'tool-start', name: 'research_web', args: { task: 'orpheus tts' }, callId: 'c2' },
  { type: 'subagent-event', parentCallId: 'c2', event: { type: 'tool-start', name: 'web_search', args: {}, callId: 'n1' } },
  { type: 'subagent-event', parentCallId: 'c2', event: { type: 'tool-result', name: 'web_search', summary: 'searched (5)', callId: 'n1', result: { hits: 5 } } },
  { type: 'tool-result', name: 'research_web', summary: 'research: orpheus tts (1 tool calls)', callId: 'c2', args: { task: 'orpheus tts' }, result: { report: 'R' }, kind: 'read' },
  { type: 'tool-start', name: 'exec', args: { command: 'ls' }, callId: 'c3' },
  { type: 'tool-result', name: 'exec', summary: 'denied: exec', callId: 'c3', args: { command: 'ls' }, result: { denied: true }, kind: 'destructive' },
  { type: 'text-delta', text: 'Found two notes and a report.' },
  { type: 'usage', inputTokens: 100, outputTokens: 20, totalTokens: 120 }
]

function shape(m: AgentUIMessage) {
  return {
    role: m.role,
    reasoning: m.parts.filter(p => p.type === 'reasoning').map(p => (p as { text: string }).text).join(''),
    usage: m.metadata?.usage,
    parts: m.parts.filter(p => p.type !== 'step-start' && p.type !== 'reasoning').map((p) => {
      if (p.type === 'text') return { text: p.text }
      if (p.type === 'dynamic-tool') return { tool: p.toolName, id: p.toolCallId, state: p.state, input: p.input, output: 'output' in p ? p.output : undefined, errorText: 'errorText' in p ? p.errorText : undefined }
      if (p.type === 'data-subagent') return { subagent: p.data.steps }
      return { other: p.type }
    })
  }
}

describe('live ↔ resume parity', () => {
  it('a turn renders the same live and after resume', async () => {
    // (a) live
    const frames: AgentMessageFrame[] = []
    const ts = createTurnStream({ turnId: 1, send: d => { if (typeof d === 'string') { const f = JSON.parse(d); if (f.type === 'chunk' || f.type === 'user-message') frames.push(f) } } })
    let reasoning = ''
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null = null
    const out = await handleTurn('find orpheus', [], {
      tts: { async *synthesize() {} } as never, preset, signal: new AbortController().signal, speak: false,
      emit: (e: VoiceEvent) => {
        if (e.type === 'reasoning') reasoning += e.text
        else if (e.type === 'usage') usage = { inputTokens: e.inputTokens, outputTokens: e.outputTokens, totalTokens: e.totalTokens }
        ts.emit(e)
      },
      async *runAgent() { for (const e of agentEvents) yield e }
    })
    ts.finish()
    const live: AgentUIMessage[] = []
    const turns = createClientTurns({ upsert: (m) => { const i = live.findIndex(x => x.id === m.id); if (i >= 0) live[i] = m; else live.push(m) } })
    for (const f of frames) turns.handle(f)
    await turns.settled()

    // (b) persisted → resumed
    const persisted = buildTurnPersistPayload(out, { inputModality: 'text', speakFlag: false, attachments: [], reasoning, usage })
    const resumed = toUIMessages(persisted.map((p, i): ResumeMessage => ({
      id: `r${i}`, role: p.role, content: p.content,
      toolCalls: (p.toolCalls ?? null) as ResumeMessage['toolCalls'],
      reasoning: p.reasoning, attachments: p.attachments, usage: p.usage
    })))

    expect(live.map(shape)).toEqual(resumed.map(shape))
    // and the parity is not vacuous: the interesting parts are really there
    const tools = shape(live[1]!).parts.filter(p => 'tool' in p)
    expect(tools.map(t => (t as { state: string }).state)).toEqual(['output-available', 'output-available', 'output-denied'])
    expect(shape(live[1]!).parts.some(p => 'subagent' in p)).toBe(true)
  })
})
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm vitest run test/agent-ui-parity.test.ts app/lib/agent/`
Expected: PASS. If the only difference is `undefined` vs absent keys, fix the producer, not the shape function. If `persisted.map`'s field names differ from `NewConvMessage` (check `server/services/conversations.ts`), adapt the mapping — do not loosen `shape`.

- [ ] **Step 7: Mutation check (do not commit)**

In `to-ui-messages.ts`, drop the `data-subagent` push → parity goes red; revert. In `orchestrator.ts`, persist `steps` without the running→error mapping and add a still-running nested step to `agentEvents` → parity goes red; revert both.

- [ ] **Step 8: Commit**

```bash
git add app/lib/agent/to-ui-messages.ts app/lib/agent/to-ui-messages.test.ts test/agent-ui-parity.test.ts
git commit -m "feat(agent-ui): resume threads as UIMessages, guarded by a live/resume parity test"
```

---

### Task 9: The Elements conversation components (built on the fixture page)

**Files:**
- Create: `app/lib/agent/render.ts`, `app/lib/agent/render.test.ts`, `app/components/agent/Conversation.vue`, `app/components/agent/ToolPart.vue`, `app/components/agent/SubagentSteps.vue`, `app/components/agent/Attachment.vue`
- Create: `app/components/agent/ReplyActions.vue` (the `AgentUIMessage` successor of `MessageActions.vue`, which `voice/Transcript.vue` still uses until Task 10 deletes both — rewriting it in place would break typecheck between the tasks)
- Modify: `app/pages/dev/elements.vue` (render `AgentConversation` from typed fixtures)

**Interfaces:**
- Consumes: `AgentUIMessage` / `AgentUIPart` / `ToolEnvelope` / `SubagentStep` (Task 1); Elements from Task 0.
- Produces:
  - `render.ts`: `uiMessageText(m: AgentUIMessage): string`, `subagentSteps(m: AgentUIMessage, toolCallId: string): SubagentStep[] | null`, `tokenLabel(usage?: MessageUsage): string`, `toolTitle(name: string): string`, `isRunning(p: AgentUIPart): boolean`.
  - `<AgentConversation :messages :undone @undo(toolCallId, undoToken) @retry(messageId) @pick(prompt)>` — `undone: ReadonlySet<string>` of toolCallIds.
  - `<AgentReplyActions :message @retry>`.

- [ ] **Step 1: Write the failing tests** — `app/lib/agent/render.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { uiMessageText, subagentSteps, tokenLabel, toolTitle, isRunning } from './render'
import type { AgentUIMessage } from '~~/shared/types/agent-ui'

const m: AgentUIMessage = {
  id: 'a', role: 'assistant',
  parts: [
    { type: 'text', text: 'Looking. ', state: 'done' },
    { type: 'dynamic-tool', toolName: 'research_web', toolCallId: 'c1', state: 'input-available', input: {} },
    { type: 'data-subagent', id: 'c1', data: { steps: [{ callId: 'n1', name: 'web_search', state: 'running' }] } },
    { type: 'text', text: 'Done.', state: 'done' }
  ]
}

describe('render helpers', () => {
  it('uiMessageText joins text parts only', () => { expect(uiMessageText(m)).toBe('Looking. Done.') })
  it('subagentSteps finds the data part for a tool call', () => {
    expect(subagentSteps(m, 'c1')).toEqual([{ callId: 'n1', name: 'web_search', state: 'running' }])
    expect(subagentSteps(m, 'nope')).toBeNull()
  })
  it('tokenLabel renders nothing for absent/zero usage', () => {
    expect(tokenLabel(undefined)).toBe('')
    expect(tokenLabel({ totalTokens: 0 })).toBe('')
    expect(tokenLabel({ totalTokens: 950 })).toBe('950 tok')
    expect(tokenLabel({ totalTokens: 1840 })).toBe('1.8k tok')
  })
  it('toolTitle humanizes snake_case', () => { expect(toolTitle('research_web')).toBe('Research web') })
  it('isRunning is true only for unfinished tools', () => {
    expect(isRunning(m.parts[1]!)).toBe(true)
    expect(isRunning(m.parts[0]!)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run app/lib/agent/render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `render.ts`**

```ts
// Pure render helpers for the agent conversation — kept out of the SFCs so they are testable
// without mounting components.
import type { AgentUIMessage, AgentUIPart, SubagentStep } from '~~/shared/types/agent-ui'
import type { MessageUsage } from '~~/shared/types/conversation'

export function uiMessageText(m: AgentUIMessage): string {
  return m.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('')
}

export function subagentSteps(m: AgentUIMessage, toolCallId: string): SubagentStep[] | null {
  const part = m.parts.find(p => p.type === 'data-subagent' && p.id === toolCallId)
  return part && part.type === 'data-subagent' ? part.data.steps : null
}

/** Absent usage renders nothing rather than a misleading zero. */
export function tokenLabel(usage?: MessageUsage | null): string {
  const t = usage?.totalTokens
  if (typeof t !== 'number' || t <= 0) return ''
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k tok` : `${t} tok`
}

export function toolTitle(name: string): string {
  const s = name.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function isRunning(p: AgentUIPart): boolean {
  return p.type === 'dynamic-tool' && (p.state === 'input-streaming' || p.state === 'input-available')
}
```

Run: `pnpm vitest run app/lib/agent/render.test.ts` → PASS.

- [ ] **Step 4: The components**

`app/components/agent/SubagentSteps.vue`:

```vue
<script setup lang="ts">
import type { SubagentStep } from '~~/shared/types/agent-ui'
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'
import { toolTitle } from '~/lib/agent/render'

defineProps<{ steps: SubagentStep[]; running: boolean }>()
const status = (s: SubagentStep) => (s.state === 'running' ? 'active' : 'complete') as 'active' | 'complete'
</script>

<template>
  <ChainOfThought :default-open="running">
    <ChainOfThoughtHeader>{{ steps.length }} step{{ steps.length === 1 ? '' : 's' }}</ChainOfThoughtHeader>
    <ChainOfThoughtContent>
      <ChainOfThoughtStep
        v-for="s in steps"
        :key="s.callId"
        :label="toolTitle(s.name)"
        :description="s.state === 'error' ? `${s.summary ?? 'failed'}` : s.summary"
        :status="status(s)"
        :class="s.state === 'error' ? 'text-error' : ''"
      />
    </ChainOfThoughtContent>
  </ChainOfThought>
</template>
```

`app/components/agent/ToolPart.vue`:

```vue
<script setup lang="ts">
import type { AgentUIPart, SubagentStep, ToolEnvelope } from '~~/shared/types/agent-ui'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { toolTitle, isRunning } from '~/lib/agent/render'

const props = defineProps<{ part: Extract<AgentUIPart, { type: 'dynamic-tool' }>; steps: SubagentStep[] | null; undone?: boolean }>()
const emit = defineEmits<{ undo: [undoToken: string] }>()

const envelope = computed(() => (props.part.state === 'output-available' ? props.part.output as ToolEnvelope : null))
const running = computed(() => isRunning(props.part))
</script>

<template>
  <Tool :default-open="false">
    <ToolHeader
      type="dynamic-tool"
      :tool-name="part.toolName"
      :state="part.state"
      :title="envelope?.summary ?? toolTitle(part.toolName)"
    />
    <ToolContent>
      <ToolInput :input="part.input" />
      <ToolOutput
        :output="envelope?.value"
        :error-text="part.state === 'output-error' ? part.errorText : part.state === 'output-denied' ? 'Denied' : undefined"
      />
    </ToolContent>
  </Tool>
  <div
    v-if="envelope?.undoToken"
    class="-mt-3 mb-3 flex justify-end"
  >
    <UButton
      v-if="!undone"
      size="xs"
      variant="link"
      color="primary"
      icon="i-lucide-undo-2"
      label="Undo"
      @click="emit('undo', envelope!.undoToken!)"
    />
    <span
      v-else
      class="text-xs text-muted"
    >undone</span>
  </div>
  <AgentSubagentSteps
    v-if="steps?.length"
    :steps="steps"
    :running="running"
    class="mb-3"
  />
</template>
```

`app/components/agent/Attachment.vue` (the user-attachment rendering moved out of `voice/Transcript.vue`):

```vue
<script setup lang="ts">
import type { FileUIPart } from 'ai'
defineProps<{ part: FileUIPart }>()
</script>

<template>
  <img
    v-if="part.mediaType.startsWith('image/')"
    :src="part.url"
    :alt="part.filename || 'attachment'"
    class="max-h-32 rounded-md border border-default object-cover"
  >
  <a
    v-else
    :href="part.url"
    :download="part.filename || true"
    class="inline-flex items-center gap-1.5 rounded-md border border-default bg-elevated px-2 py-1 text-xs text-default hover:bg-accented"
  >
    <UIcon name="i-lucide-file" class="size-3.5" />
    <span class="truncate max-w-[12rem]">{{ part.filename || 'file' }}</span>
  </a>
</template>
```

`app/components/agent/ReplyActions.vue`:

```vue
<!-- app/components/agent/ReplyActions.vue -->
<script setup lang="ts">
import type { AgentUIMessage } from '~~/shared/types/agent-ui'
import { uiMessageText, tokenLabel } from '~/lib/agent/render'

const props = defineProps<{ message: AgentUIMessage }>()
const emit = defineEmits<{ retry: [] }>()

const toast = useToast()
const copied = ref(false)

async function copy() {
  try {
    await navigator.clipboard.writeText(uiMessageText(props.message))
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch {
    toast.add({ color: 'error', title: 'Copy failed', description: 'The browser blocked clipboard access.' })
  }
}

const time = computed(() => {
  const at = props.message.metadata?.createdAt
  return at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
})
const tokens = computed(() => tokenLabel(props.message.metadata?.usage))
</script>

<template>
  <div class="flex items-center gap-2 pt-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
    <UButton :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'" size="xs" variant="ghost" color="neutral" :aria-label="copied ? 'Copied' : 'Copy message'" @click="copy" />
    <UButton v-if="message.role === 'assistant'" icon="i-lucide-refresh-cw" size="xs" variant="ghost" color="neutral" aria-label="Retry this reply" @click="emit('retry')" />
    <span v-if="time" class="text-[10px] text-dimmed tabular-nums">{{ time }}</span>
    <span v-if="tokens" class="text-[10px] text-dimmed tabular-nums">{{ tokens }}</span>
  </div>
</template>
```

`app/components/agent/Conversation.vue`:

```vue
<!-- app/components/agent/Conversation.vue -->
<script setup lang="ts">
// The agent conversation, rendered from AI SDK UIMessages with AI Elements Vue. Replaces
// voice/Transcript.vue: scrolling (stick-to-bottom + scroll button) and streaming markdown
// now come from Elements instead of hand-rolled ResizeObserver/MDC-cache-key plumbing.
import type { AgentUIMessage } from '~~/shared/types/agent-ui'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { subagentSteps } from '~/lib/agent/render'

defineProps<{ messages: AgentUIMessage[]; undone?: ReadonlySet<string> }>()
const emit = defineEmits<{ undo: [toolCallId: string, undoToken: string]; retry: [messageId: string]; pick: [prompt: string] }>()
</script>

<template>
  <Conversation
    class="min-h-0"
    data-ai-elements
  >
    <ConversationContent>
      <AgentEmptyState
        v-if="!messages.length"
        @pick="(p: string) => emit('pick', p)"
      />
      <div
        v-for="m in messages"
        :key="m.id"
        class="group"
      >
        <Message :from="m.role">
          <MessageContent>
            <template
              v-for="(p, i) in m.parts"
              :key="`${m.id}-${i}`"
            >
              <template v-if="p.type === 'text'">
                <MessageResponse
                  v-if="m.role === 'assistant'"
                  :content="p.text"
                />
                <p
                  v-else
                  class="whitespace-pre-wrap"
                >{{ p.text }}</p>
              </template>
              <Reasoning
                v-else-if="p.type === 'reasoning'"
                :is-streaming="p.state === 'streaming'"
                :default-open="false"
              >
                <ReasoningTrigger />
                <ReasoningContent :content="p.text" />
              </Reasoning>
              <AgentToolPart
                v-else-if="p.type === 'dynamic-tool'"
                :part="p"
                :steps="subagentSteps(m, p.toolCallId)"
                :undone="undone?.has(p.toolCallId)"
                @undo="(t: string) => emit('undo', p.toolCallId, t)"
              />
              <AgentAttachment
                v-else-if="p.type === 'file'"
                :part="p"
              />
            </template>
            <UAlert
              v-if="m.metadata?.errorText"
              color="error"
              variant="subtle"
              :title="m.metadata.errorText"
            />
            <span
              v-else-if="m.metadata?.interrupted"
              class="text-xs text-dimmed"
            >stopped</span>
          </MessageContent>
        </Message>
        <AgentReplyActions
          :message="m"
          @retry="emit('retry', m.id)"
        />
      </div>
    </ConversationContent>
    <ConversationScrollButton />
  </Conversation>
</template>
```

(`data-subagent` parts are rendered by their tool, so the part loop skips them; `step-start` parts render nothing.)

- [ ] **Step 5: Drive the components from typed fixtures**

In `app/pages/dev/elements.vue`, add to `<script setup>` (after the existing `md` constant):

```ts
import type { AgentUIMessage } from '~~/shared/types/agent-ui'

const undone = reactive(new Set<string>())
const fixture: AgentUIMessage[] = [
  {
    id: 'u1', role: 'user',
    parts: [
      { type: 'text', text: 'Find my notes on Orpheus and check the web' },
      { type: 'file', mediaType: 'image/png', url: `/api/images/${IMAGE_ID}/raw`, filename: 'screenshot.png' }
    ],
    metadata: { createdAt: '2026-09-19T10:00:00.000Z' }
  },
  {
    id: 'a1', role: 'assistant',
    metadata: { createdAt: '2026-09-19T10:00:05.000Z', usage: { inputTokens: 1500, outputTokens: 340, totalTokens: 1840 } },
    parts: [
      { type: 'reasoning', text: 'Documents first, then a research pass.', state: 'done' },
      { type: 'text', text: 'Looking. ', state: 'done' },
      { type: 'dynamic-tool', toolName: 'web_fetch', toolCallId: 't-run', state: 'input-available', input: { url: 'https://example.com' } },
      { type: 'dynamic-tool', toolName: 'create_task', toolCallId: 't-ok', state: 'output-available', input: { title: 'Try Orpheus' },
        output: { value: { id: 'task1', title: 'Try Orpheus' }, summary: "added 'Try Orpheus' to todo", undoToken: 'fixture-undo', kind: 'create' } },
      { type: 'dynamic-tool', toolName: 'web_fetch', toolCallId: 't-err', state: 'output-error', input: { url: 'https://ebay.com' }, errorText: '403 Forbidden' },
      { type: 'dynamic-tool', toolName: 'exec', toolCallId: 't-deny', state: 'output-denied', input: { command: 'df -h' }, approval: { id: 't-deny', approved: false } },
      { type: 'dynamic-tool', toolName: 'research_web', toolCallId: 't-sub', state: 'input-available', input: { task: 'orpheus tts self-hosting' } },
      { type: 'data-subagent', id: 't-sub', data: { steps: [
        { callId: 'n1', name: 'web_search', summary: 'searched (5)', state: 'done' },
        { callId: 'n2', name: 'web_fetch', summary: 'failed: web_fetch', state: 'error' },
        { callId: 'n3', name: 'web_fetch', state: 'running' }
      ] } },
      { type: 'text', text: md, state: 'done' }
    ]
  },
  {
    id: 'a2', role: 'assistant',
    metadata: { createdAt: '2026-09-19T10:01:00.000Z', errorText: 'model unavailable' },
    parts: [{ type: 'text', text: 'Partial answer before the model dro', state: 'done' }]
  }
]
```

And make the top of the `<template>` render it (keep the Task 0 raw-Elements block below; it documents the spike):

```vue
  <div class="h-full overflow-y-auto p-4 flex flex-col gap-8">
    <AgentConversation
      class="h-[70vh]"
      :messages="fixture"
      :undone="undone"
      @undo="(id: string) => undone.add(id)"
    />
    <!-- Task 0 spike block (unchanged) follows -->
```

(Close the new outer `div` after the existing spike block.)

- [ ] **Step 6: Browser-validate the components (browser-testing skill)**

On `http://localhost:3217/dev/elements`, light and dark:
- screenshot and **Read** it: every tool state has the right badge; the error message shows the alert; the user bubble is grey; markdown table/code/link/image render.
- expand a tool (real `click` on its header ref) → input JSON and output show; the running tool shows its spinner/"Running".
- the subagent steps show 3 steps, the running one active, the error one red.
- click Undo → it flips to "undone".
- hover a message → copy / retry / time / "1.8k tok" appear.
- `pnpm typecheck` → 0 errors.

- [ ] **Step 7: Commit**

```bash
git add app/lib/agent/render.ts app/lib/agent/render.test.ts app/components/agent/Conversation.vue app/components/agent/ToolPart.vue app/components/agent/SubagentSteps.vue app/components/agent/Attachment.vue app/components/agent/ReplyActions.vue app/pages/dev/elements.vue
git commit -m "feat(agent-ui): Elements-based conversation — tools, subagent steps, reasoning, actions"
```

---

### Task 10: Switch `/agent` onto UIMessages (useVoice, frames, page, retry) and delete the old transcript

**Files:**
- Modify: `app/composables/useVoice.ts`, `app/lib/voice/messages.ts`, `app/lib/voice/messages.test.ts`, `test/voice-messages.test.ts`, `app/lib/agent/retry.ts`, `app/lib/agent/retry.test.ts`, `app/pages/agent/index.vue`, `app/components/voice/Composer.vue`
- Delete: `app/components/voice/Transcript.vue`, `app/components/agent/ReasoningBlock.vue`, `app/components/agent/MessageActions.vue`, `app/lib/agent/transcript.ts`, `app/lib/agent/transcript.test.ts`, `app/composables/useTextChat.ts`, `app/composables/useAgentActivity.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `mapServerMessage` effects: `messageFrame?: AgentMessageFrame`; `audioBegin?: { segmentId: number; sampleRate: number; turnId?: number }`; the `delta` / `reasoning` / `tool` / `usage` effects are removed. A `user-message` frame still yields `events: [{ type: 'sttFinal', chars }]`.
  - `useVoice()` returns `messages: Ref<AgentUIMessage[]>` instead of `transcript`; `sendText(text, speak?, attachments?)` unchanged.
  - `truncateForRetry(messages: AgentUIMessage[], messageId: string): { messages: AgentUIMessage[]; text: string; attachments: AttachmentRef[] } | null`.

- [ ] **Step 1: Update the frame-mapping tests first**

In `test/voice-messages.test.ts` and `app/lib/voice/messages.test.ts`: delete the cases for `transcript`, `reasoning`, `tool` and `usage` frames, and add:

```ts
  it('passes chunk frames through as messageFrame', () => {
    const frame = { type: 'chunk', turnId: 3, chunk: { type: 'text-delta', id: 't', delta: 'hi' } }
    expect(mapServerMessage(frame as never, false)).toEqual({ messageFrame: frame, events: [] })
  })

  it('a user-message frame is a messageFrame plus the sttFinal viz event', () => {
    const frame = { type: 'user-message', turnId: 3, message: { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hello world' }] } }
    expect(mapServerMessage(frame as never, false)).toEqual({ messageFrame: frame, events: [{ type: 'sttFinal', chars: 11 }] })
  })

  it('audio-begin carries its turnId', () => {
    expect(mapServerMessage({ type: 'audio-begin', segmentId: 1, sampleRate: 24000, turnId: 3 } as never, false).audioBegin)
      .toEqual({ segmentId: 1, sampleRate: 24000, turnId: 3 })
  })
```

Rewrite `app/lib/agent/retry.test.ts` for the new signature:

```ts
import { describe, it, expect } from 'vitest'
import { truncateForRetry } from './retry'
import type { AgentUIMessage } from '~~/shared/types/agent-ui'

const user = (id: string, text: string, attachments?: AgentUIMessage['metadata']): AgentUIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }], metadata: attachments })
const bot = (id: string, text: string): AgentUIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text, state: 'done' }] })

describe('truncateForRetry', () => {
  it('drops the preceding user turn and everything after, returning what to re-send', () => {
    const att = [{ id: 'i1', kind: 'image' as const, mime: 'image/png' }]
    const msgs = [user('u1', 'first'), bot('a1', 'one'), user('u2', 'second', { attachments: att }), bot('a2', 'two')]
    expect(truncateForRetry(msgs, 'a2')).toEqual({ messages: [msgs[0], msgs[1]], text: 'second', attachments: att })
  })
  it('retrying an earlier reply drops the later turns too', () => {
    const msgs = [user('u1', 'first'), bot('a1', 'one'), user('u2', 'second'), bot('a2', 'two')]
    expect(truncateForRetry(msgs, 'a1')).toEqual({ messages: [], text: 'first', attachments: [] })
  })
  it('returns null for an unknown id or no preceding user turn', () => {
    expect(truncateForRetry([bot('a1', 'x')], 'a1')).toBeNull()
    expect(truncateForRetry([user('u1', 'x')], 'nope')).toBeNull()
  })
})
```

Run: `pnpm vitest run test/voice-messages.test.ts app/lib/voice/messages.test.ts app/lib/agent/retry.test.ts`
Expected: FAIL (old implementations).

- [ ] **Step 2: `messages.ts` and `retry.ts`**

`app/lib/voice/messages.ts`:
- Add `import type { AgentMessageFrame } from '~~/shared/types/agent-ui'`; add `turnId?: number` to `ServerMsg`.
- In `MsgEffect`: remove `delta`, `reasoning`, `tool`, `usage`; add `messageFrame?: AgentMessageFrame`; change `audioBegin` to `{ segmentId: number; sampleRate: number; turnId?: number }`.
- In `mapServerMessage`: delete the `transcript` / `reasoning` / `tool` / `usage` branches; add at the top:

```ts
  if (m.type === 'chunk') return { messageFrame: m as unknown as AgentMessageFrame, events }
  if (m.type === 'user-message') {
    const frame = m as unknown as Extract<AgentMessageFrame, { type: 'user-message' }>
    const chars = frame.message.parts.filter(p => p.type === 'text').reduce((n, p) => n + (p as { text: string }).text.length, 0)
    return { messageFrame: frame, events: [{ type: 'sttFinal', chars }] }
  }
```

  and make the `audio-begin` branch return `{ audioBegin: { segmentId: m.segmentId as number, sampleRate: m.sampleRate as number, turnId: m.turnId }, events }`. Drop the now-unused `MessageUsage` import.

`app/lib/agent/retry.ts` (replace the file):

```ts
// app/lib/agent/retry.ts
//
// Pure "walk back to the preceding user turn and truncate" logic behind retryTurn. Replaces
// in place — it does NOT fork. The user turn is re-sent through sendText, whose server echo
// (a user-message frame) re-creates it, so it is removed here too.
import type { AgentUIMessage } from '~~/shared/types/agent-ui'
import type { AttachmentRef } from '~~/shared/types/conversation'

export interface RetryPlan {
  messages: AgentUIMessage[]
  text: string
  attachments: AttachmentRef[]
}

export function truncateForRetry(messages: AgentUIMessage[], messageId: string): RetryPlan | null {
  const i = messages.findIndex(m => m.id === messageId)
  if (i < 0) return null
  let j = i - 1
  while (j >= 0 && messages[j]!.role !== 'user') j--
  if (j < 0) return null
  const user = messages[j]!
  const text = user.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('')
  return { messages: messages.slice(0, j), text, attachments: user.metadata?.attachments ?? [] }
}
```

Run the Step 1 tests → PASS.

- [ ] **Step 3: `useVoice.ts`**

- Imports: remove `MessageUsage`; add `import type { AgentUIMessage } from '~~/shared/types/agent-ui'` and `import { createClientTurns } from '../lib/agent/turn-stream'`.
- Delete `TranscriptEntry`, `newEntryId`, `pendingUserAttachments`, `pushDelta`, `pushReasoning`, `pushTool`, `setUsage`.
- Replace `const transcript = ref<TranscriptEntry[]>([])` with:

```ts
  const messages = ref<AgentUIMessage[]>([])
  // One readUIMessageStream per turn (lib/agent/turn-stream.ts). upsert replaces a message by
  // id (a streamed snapshot) or appends it (a new user/assistant message).
  const turns = createClientTurns({
    upsert: (m) => {
      const list = messages.value
      const i = list.findIndex(x => x.id === m.id)
      if (i >= 0) list.splice(i, 1, m)
      else list.push(m)
    }
  })
```

- In `socket.onmessage`'s JSON branch, replace the `fx.audioBegin` / `fx.delta` / `fx.reasoning` / `fx.tool` / `fx.usage` lines with:

```ts
        // audio-begin now names its turn: a segment from a superseded turn is rejected
        // outright (closes the barge-in window documented on onAudioBegin).
        if (fx.audioBegin) {
          if (fx.audioBegin.turnId !== undefined && turns.isStale(fx.audioBegin.turnId)) epochs.rejectSegment()
          else onAudioBegin(fx.audioBegin.sampleRate)
        }
        if (fx.messageFrame) turns.handle(fx.messageFrame)
```

- `socket.onclose`: add `turns.disconnect()`. In `socket.onopen` (inside `connectInner`), add `turns.reset()` before `resolve()`.
- In the VAD `onSpeechStart` barge-in branch and in `stop()`, add `turns.interrupt()` next to `stopPlayback()`.
- In `sendText`: delete `pendingUserAttachments = attachments`.
- `newConversation`: `messages.value = []` (instead of `transcript.value = []`) and `turns.interrupt()`.
- In the returned object replace `transcript` with `messages`.
- Update the comment on `onAudioBegin` that says "no frame carries a turn id": it now does; the residual window is gone for tagged frames.

- [ ] **Step 4: Page, composer, deletions**

`app/components/voice/Composer.vue`: remove the `TranscriptEntry` import and the `entries` prop.

`app/pages/agent/index.vue`:
- Imports: replace the `TranscriptEntry` and `buildResumeTranscript` imports with `import { toUIMessages } from '~/lib/agent/to-ui-messages'` and `import { uiMessageText } from '~/lib/agent/render'`.
- Caption:

```ts
const caption = computed(() => {
  const list = voice.messages.value
  for (let i = list.length - 1; i >= 0; i--) {
    const text = uiMessageText(list[i]!)
    if (text) return { id: list[i]!.id, text }
  }
  return null
})
```

- Undo:

```ts
// Tool calls undone this session (by toolCallId). Resumed tool parts start not-undone,
// exactly as the old chips did.
const undone = reactive(new Set<string>())
async function undoTool(toolCallId: string, undoToken: string) {
  try {
    const { ok } = await redeem(undoToken)
    if (ok) undone.add(toolCallId)
  } catch (e) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Undo failed', description: err?.data?.statusMessage ?? err?.message })
  }
}
```

- `resume()`: `const next = toUIMessages(messages)` and `voice.messages.value = next` (instead of the transcript lines).
- Retry:

```ts
async function retryTurn(messageId: string) {
  const plan = truncateForRetry(voice.messages.value, messageId)
  if (!plan) return
  voice.messages.value = plan.messages
  await voice.sendText(plan.text, speakReply.value, plan.attachments)
}
```

- Template: replace `<VoiceTranscript … />` with

```vue
        <AgentConversation
          class="flex-1 min-h-0"
          :messages="voice.messages.value"
          :undone="undone"
          @undo="undoTool"
          @retry="retryTurn"
          @pick="pickStarter"
        />
```

  and drop `:entries="voice.transcript.value"` from `<VoiceComposer>`.

Delete the dead files:

```bash
git rm app/components/voice/Transcript.vue app/components/agent/ReasoningBlock.vue app/components/agent/MessageActions.vue app/lib/agent/transcript.ts app/lib/agent/transcript.test.ts app/composables/useTextChat.ts app/composables/useAgentActivity.ts
grep -rn "TranscriptEntry\|newEntryId\|buildResumeTranscript\|useTextChat\|useAgentActivity\|VoiceTranscript\|AgentReasoningBlock\|AgentMessageActions" app server shared test
```

Expected: the grep prints nothing. `app/utils/transcript-scroll.ts` stays (the sessions transcript uses it); if `test/agent-transcript-scroll.test.ts` only exercised `Transcript.vue` behaviour, leave it — it tests the util.

- [ ] **Step 5: Gates**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 0 errors / all green / exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A app/composables/useVoice.ts app/lib/voice/messages.ts app/lib/voice/messages.test.ts test/voice-messages.test.ts app/lib/agent/retry.ts app/lib/agent/retry.test.ts app/pages/agent/index.vue app/components/voice/Composer.vue
git commit -m "feat(agent): render /agent from streamed UIMessages; retire the hand-rolled transcript"
```

---

### Task 11: Live validation, docs, handover

**Files:**
- Modify: `docs/wiki/agent.md`, `docs/wiki/voice-agent.md`, `docs/superpowers/plans/00-roadmap.md`, `docs/BACKLOG.md`
- Create: `docs/handovers/2026-09-19-agent-elements-foundation.md`

- [ ] **Step 1: Browser validation on `/agent` (browser-testing skill, dev on the spare port)**

Each item: drive it, screenshot, **Read** the PNG, and assert with `playwright-cli eval` where noted.

1. Typed turn with a tool ("What are my open tasks?"): the tool shows **Running** while it runs, then **Completed**; expand it (real click) → input and output visible; the reply renders markdown.
2. Subagent turn ("Research the latest on self-hosted TTS"): nested steps appear **while** the research runs (take two screenshots a few seconds apart; the step count grows), then settle.
3. Exec denial ("Check disk usage on the app box" → Deny in the approval prompt): the tool shows **Denied**.
4. Stop mid-tool (send a research question, click Stop while a tool runs): the tool shows **Error / Stopped**, nothing keeps spinning, the message shows "stopped".
5. Speak-mode turn (toggle speak, send a short question): audio plays (state goes `speaking`) and the text renders.
6. Resume a **legacy** thread (one from before this cycle, via the thread rail) and a **new** one: tools render at their inline positions with Completed state; subagent steps show on the new one.
7. Retry the last reply: the user message is re-sent and a new reply streams.
8. Undo from a tool part (e.g. ask it to create a task, then Undo): flips to "undone"; the task is gone (`fetch('/api/tasks?…')`).
9. Light and dark: repeat a screenshot of item 1 in the other mode.
10. `/dev/elements` still renders; `/`, `/tasks`, `/documents`, `/settings` still match the Task 0 "after" screenshots.

Fix any defect found (each fix: failing test first where the logic is testable, then the fix, then re-validate), committing each fix separately.

- [ ] **Step 2: Wiki**

- `docs/wiki/agent.md`: rewrite the WS protocol section (frames table from Task 6), the UI section (Conversation / ToolPart / SubagentSteps on AI Elements; the token bridge; `data-ai-elements`), the conversation-store/resume section (`toUIMessages`, `steps` on tool records), and the tool-event flow (the runAgent channel, `onNestedEvent`). Bump `updated:`.
- `docs/wiki/voice-agent.md`: frame table (`audio-begin` gains `turnId`; transcript/reasoning/tool/usage frames removed); note the stale-segment rejection.
- Mirror both with the `wiki-mirror` skill (probe first; REST PUT via a temporary token; write back `mymind_hash`; delete the token).

- [ ] **Step 3: Handover, roadmap, backlog**

- `docs/handovers/2026-09-19-agent-elements-foundation.md` with accurate frontmatter (`title`, `cycle: 64`, `date`, `status`, `branch`, `spec`, `plan`, `docs`, `shipped`, `deferred`, `next_seam`) — status must say BUILT/NOT MERGED unless Tony authorizes a merge. Record: the spike report's numbers, every deviation above, the measured gates, and the browser-validation results.
- Roadmap: add the cycle 64 row. BACKLOG: strike the items this cycle closed; point cycle 65–67 at their MyMind tasks (`3ddae408`, `14d0074b`, `d321c732`).
- Mirror the handover to MyMind under `/projects/mymind/handovers/`.
- MyMind task `3a32a2ca` (cycle 64): update to reflect the state (in progress → done when merged).

- [ ] **Step 4: Final gates and commit**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: green.

```bash
git add docs/
git commit -m "docs: cycle 64 handover, wiki, roadmap and backlog"
```
