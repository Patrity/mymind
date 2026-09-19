// server/lib/agent/run.ts
import { streamText as realStreamText, stepCountIs } from 'ai'
import { reasoningChain } from './model'
import { buildAiTools } from './ai-tools'
import { buildSystemPrompt as realBuildSystemPrompt } from './prompt'
import { bridgetProfile, type AgentProfile } from './profile'
import { publishActivity } from './bus'
import { VOICE_TUNING } from '../voice/tuning'
import type { AgentTool, ToolStartEvent, ToolResultEvent, SubagentEvent } from './types'
import { recordEvent } from '../observability/record'
import { redactImageUrlsForModel } from './image-embed'
import { applyHistoryPolicy, toolBlocksFor } from './tool-history'

export type { AgentContentPart } from './types'
import type { AgentContentPart } from './types'

export type AgentMessage =
  | { role: 'system' | 'user'; content: string | AgentContentPart[] }
  | { role: 'assistant'; content: string | AgentContentPart[]; toolRecords?: import('./tool-history').AgentToolRecord[] }

export function messageText(content: string | AgentContentPart[]): string {
  return typeof content === 'string'
    ? content
    : content.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n')
}

/** Map our content → AI SDK message content for streamText. Redaction applies to text only. */
export function toModelContent(role: AgentMessage['role'], content: string | AgentContentPart[]): unknown {
  const redact = (t: string) => role === 'assistant' ? redactImageUrlsForModel(t) : t
  if (typeof content === 'string') return redact(content)
  return content.map(p => p.type === 'text'
    ? { type: 'text', text: redact(p.text) }
    : { type: 'image', image: p.image })
}

/**
 * The ONE place history becomes model messages. Policy + expansion live here rather than at
 * the two callers (orchestrator live history, getAgentHistory on resume) so those paths
 * cannot drift apart — a future edit to either physically cannot skip this.
 */
export function buildModelMessages(messages: AgentMessage[]): unknown[] {
  const policed = applyHistoryPolicy(messages.filter(m => m.role !== 'system'))
  return policed.flatMap(m => {
    const text = { role: m.role, content: toModelContent(m.role, m.content) }
    const records = m.role === 'assistant' ? m.toolRecords : undefined
    return records?.length ? [...toolBlocksFor(records), text] : [text]
  })
}

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | ToolStartEvent
  | ToolResultEvent
  | SubagentEvent
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; totalTokens?: number; contextTokens?: number; modelDefId?: string }
  | { type: 'done' }

// Map one AI SDK v6 fullStream part to a text/reasoning event (or null for
// anything else). AI SDK v6 carries `.delta`; test fakes may use `.text` — accept
// both. Shared by the main loop and the forced-final follow-up below.
function partToEvent(part: unknown): { type: 'text-delta' | 'reasoning-delta'; text: string } | null {
  const t = (part as { type?: unknown }).type
  if (t !== 'text-delta' && t !== 'reasoning-delta') return null
  const p = part as { delta?: string; text?: string }
  const text = p.delta ?? p.text ?? ''
  return text ? { type: t, text } : null
}

// Map one AI SDK v6 fullStream `finish` part to a usage event (or null for anything
// else, including a `finish` with no usable usage). Read defensively the same way
// partToEvent tolerates `.delta` vs `.text` — the SDK has moved field names before
// (`usage` → `totalUsage`), so a missing or differently-shaped payload degrades to
// "no usage event" rather than a thrown error or a fabricated zero.
function partToUsageEvent(part: unknown): { type: 'usage'; inputTokens?: number; outputTokens?: number; totalTokens?: number } | null {
  if ((part as { type?: unknown }).type !== 'finish') return null
  const p = part as { totalUsage?: unknown; usage?: unknown }
  const raw = p.totalUsage ?? p.usage
  if (!raw || typeof raw !== 'object') return null
  const u = raw as { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown }
  const inputTokens = typeof u.inputTokens === 'number' ? u.inputTokens : undefined
  const outputTokens = typeof u.outputTokens === 'number' ? u.outputTokens : undefined
  const totalTokens = typeof u.totalTokens === 'number' ? u.totalTokens : undefined
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return null
  // Built from defined fields only — an omitted key (not a key set to `undefined`) is what
  // lets downstream `toEqual` assertions (and the JSON the wire actually carries) hold.
  return {
    type: 'usage',
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  }
}

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
 *  is rethrown IN ORDER by the consumer, exactly where the old for-await would have thrown.
 *
 *  The pump does not notice a consumer that stops early: it keeps draining `stream` into a
 *  channel nobody reads. That is safe TODAY only because every early exit in practice is an
 *  abort — the orchestrator's `if (deps.signal.aborted) break` and chat.post.ts's
 *  client-disconnect abort both fire `ctx.signal`, which streamText also holds as its
 *  `abortSignal`, so the model stream ends by itself. A consumer that `break`s, returns or
 *  throws WITHOUT aborting would leave the model generating (and billing) to the end; cancel
 *  the iterator in a `finally` here if that ever changes.
 *  Speak-mode implication: the pump also reads ahead of a slow consumer. In speak mode the
 *  orchestrator awaits the TTS pipeline per text delta, but that wait no longer throttles the
 *  model stream — the whole reply is pulled at model speed and buffered in the channel. */
function pump(stream: AsyncIterable<unknown>, ch: Channel): Promise<void> {
  return (async () => {
    try { for await (const part of stream) ch.push({ kind: 'part', part }) } catch (err) { ch.push({ kind: 'error', err }) } finally { ch.close() }
  })()
}

// Structural type for the streamText dep: only what runAgent actually uses.
type StreamTextFn = (args: never) => { fullStream: AsyncIterable<unknown> }

export interface RunDeps {
  streamText?: StreamTextFn
  tools?: AgentTool[]
  buildSystemPrompt?: (o: { profile?: { personaKey: string; id?: string }; speak: boolean; context?: string }) => Promise<string>
  /** Test-only override for the reasoning chain (model + registry modelDefId pairs), used
   *  in place of reasoningChain() when present. */
  chain?: { model: unknown; modelDefId: string }[]
}

// The agent is ALWAYS fully armed: the whole profile toolset (incl. exec) is
// exposed every turn. Safety lives in the approval gate (dangerous tools pause
// for allowlist-or-approval; no approval channel → auto-deny), not in tool
// stripping — the old dual-enable lever (powerful profile + exec cookie) is gone.
export async function* runAgent(
  messages: AgentMessage[],
  ctx: { signal: AbortSignal; speak?: boolean; profile?: AgentProfile; context?: string; maxSteps?: number; requestApproval?: (req: import('./types').ApprovalRequest) => Promise<{ approved: boolean }>; attachmentImageIds?: string[]; modelDefId?: string | null },
  deps: RunDeps = {}
): AsyncGenerator<AgentEvent> {
  const streamTextFn = (deps.streamText ?? realStreamText) as StreamTextFn
  const profile = ctx.profile ?? bridgetProfile
  const registry = deps.tools ?? profile.tools
  const buildPrompt = deps.buildSystemPrompt ?? realBuildSystemPrompt
  let channel = createChannel()
  const tools = buildAiTools(registry, { signal: ctx.signal, requestApproval: ctx.requestApproval, attachmentImageIds: ctx.attachmentImageIds, onEvent: e => channel.push({ kind: 'event', ev: e }) })

  // Compute the system prompt ONCE before the model loop (the persona + live
  // context are stable for the turn; the loop only retries model construction).
  const system = await buildPrompt({ profile, speak: ctx.speak ?? false, context: ctx.context })
  const maxSteps = ctx.maxSteps ?? VOICE_TUNING.agent.maxSteps

  publishActivity({ type: 'state', state: 'thinking' })

  // THE single seam where our history becomes model messages. This one line applies all
  // three transforms, and deliberately nothing else in the codebase may apply them:
  //   1. image redaction — strips /api/images URLs from prior assistant turns so the model
  //      can't copy a real URL into a new reply (see image-embed.ts);
  //   2. tool-history POLICY (applyHistoryPolicy) — the call survives forever, args/results
  //      cap in-window and elide out-of-window;
  //   3. tool-history EXPANSION (toolBlocksFor) — records become paired tool-call/tool-result
  //      messages, so live history and resumed history cannot structurally diverge.
  // Both callers (the orchestrator's live history, getAgentHistory on resume) reach the model
  // through here; a future edit to either physically cannot skip the policy.
  // Reused verbatim by the forced-final follow-up below.
  const modelMessages = buildModelMessages(messages)

  // Build the stream, trying each reasoning model in priority order. If stream
  // creation throws (bad baseURL, adapter construction), fall over to the next.
  // Mid-stream failures are NOT retried.
  const chain = deps.chain ?? (deps.streamText ? [{ model: undefined as never, modelDefId: undefined as string | undefined }] : await reasoningChain(ctx.modelDefId))
  let result: ReturnType<typeof realStreamText> | undefined
  let chosen: (typeof chain)[number]['model'] | undefined
  let chosenId: string | undefined
  let lastErr: unknown
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]!.model
    const started = Date.now()
    try {
      result = (streamTextFn as unknown as typeof realStreamText)({
        model: model as never,
        system,
        messages: modelMessages as never,
        tools,
        temperature: VOICE_TUNING.agent.temperature,
        stopWhen: stepCountIs(maxSteps),
        // Final-step guarantee: the last allowed step is text-only, so a run can
        // never end on a tool call with no reply. (Live failure: research_web
        // burned all 10 steps on searches → stream ended → "no report".)
        prepareStep: ({ stepNumber }: { stepNumber: number }) =>
          stepNumber >= maxSteps - 1 ? { toolChoice: 'none' as const } : undefined,
        abortSignal: ctx.signal
      })
      recordEvent({ kind: 'attempt', name: 'reasoning:agent', status: 'ok', severity: 'info', usage: 'reasoning', provider: (model as { label?: string } | undefined)?.label ?? null, modelId: (model as { modelId?: string } | undefined)?.modelId ?? null, attempt: i, durationMs: Date.now() - started })
      chosen = model
      chosenId = chain[i]!.modelDefId
      break
    } catch (err) {
      lastErr = err
      recordEvent({ kind: 'attempt', name: 'reasoning:agent', status: 'error', severity: 'warn', usage: 'reasoning', provider: (model as { label?: string } | undefined)?.label ?? null, modelId: (model as { modelId?: string } | undefined)?.modelId ?? null, attempt: i, durationMs: Date.now() - started, error: { message: (err as Error).message } })
    }
  }
  if (!result) {
    recordEvent({ kind: 'model', name: 'reasoning:agent-all-failed', status: 'error', severity: 'error', usage: 'reasoning', error: { message: (lastErr as Error)?.message ?? 'no reasoning model available' } })
    throw lastErr ?? new Error('no reasoning model available')
  }

  let sawText = false
  let sawToolCall = false
  let emittedText = ''
  // The LAST finish-step's usage — the context in use after the call. Multi-step totals
  // (`finish.totalUsage`) double-count history repeated into every step's prompt.
  let lastStep: { inputTokens?: number; outputTokens?: number } | null = null
  const mainPump = pump(result.fullStream, channel)
  for await (const item of channel.drain()) {
    if (item.kind === 'event') { yield item.ev; continue }
    if (item.kind === 'error') throw item.err
    const part = item.part
    const partType = (part as { type?: unknown }).type
    if (partType === 'tool-call') sawToolCall = true
    if (partType === 'finish-step') lastStep = (part as { usage?: { inputTokens?: number; outputTokens?: number } }).usage ?? null
    const ev = partToEvent(part)
    if (ev) { if (ev.type === 'text-delta') { sawText = true; emittedText += ev.text } ; yield ev }
    const usageEv = partToUsageEvent(part)
    if (usageEv) yield withContext(usageEv, lastStep, chosenId)
  }
  await mainPump

  // A tool-call emitted as PLAIN TEXT (Qwen/vLLM streaming hermes-parser bug,
  // vllm#31871) counts as text and fires no structured tool-call, so the
  // no-text guard never triggers and the turn dead-ends. Detect a dangling
  // <tool_call>/<function= marker when NO real tool-call fired.
  const sawTextToolCallMarker = !sawToolCall && /<tool_call>|<function\s*=/.test(emittedText)
  const needForcedFinal = !sawText && sawToolCall
  if ((needForcedFinal || sawTextToolCallMarker) && !ctx.signal.aborted) {
    const started = Date.now()
    const mode = sawTextToolCallMarker ? 'recovered-textcall' : 'forced-final'
    let followupText = false
    try {
      const prior = ((await result.response) as { messages?: unknown[] }).messages ?? []
      // Marker path: nudge + ALLOW tools (the call must actually run this time).
      // No-text path: force a spoken summary (tools already ran) with toolChoice:'none'.
      const nudge = sawTextToolCallMarker
        ? [{ role: 'user' as const, content: 'Your previous message contained a tool call written as plain text, so it was NOT executed. If you still need it, call the tool now as a real tool call, then answer Tony.' }]
        : []
      const followup = (streamTextFn as unknown as typeof realStreamText)({
        model: chosen as never,
        system,
        messages: [...modelMessages, ...prior, ...nudge] as never,
        tools,
        ...(sawTextToolCallMarker ? {} : { toolChoice: 'none' as const }),
        temperature: VOICE_TUNING.agent.temperature,
        abortSignal: ctx.signal
      })
      channel = createChannel()
      const followupPump = pump(followup.fullStream, channel)
      // Own lastStep, separate from the main loop's: this is a SEPARATE streamText call, so
      // its context accounting must not inherit the aborted main call's last step.
      let followupLastStep: { inputTokens?: number; outputTokens?: number } | null = null
      for await (const item of channel.drain()) {
        if (item.kind === 'event') { yield item.ev; continue }
        if (item.kind === 'error') throw item.err
        if ((item.part as { type?: unknown }).type === 'finish-step') followupLastStep = (item.part as { usage?: { inputTokens?: number; outputTokens?: number } }).usage ?? null
        const ev = partToEvent(item.part)
        if (ev) { if (ev.type === 'text-delta') followupText = true; yield ev }
        // This is a SEPARATE streamText call, so its usage does not include the aborted
        // main call's tokens — it supersedes (not adds to) any usage already yielded above,
        // since it's what actually produced the text the user sees.
        const usageEv = partToUsageEvent(item.part)
        if (usageEv) yield withContext(usageEv, followupLastStep, chosenId)
      }
      await followupPump
      recordEvent({ kind: 'attempt', name: `reasoning:agent-${mode}`, status: followupText ? 'ok' : 'warn', severity: followupText ? 'info' : 'warn', usage: 'reasoning', modelId: (chosen as { modelId?: string } | undefined)?.modelId ?? null, durationMs: Date.now() - started })
    } catch (err) {
      recordEvent({ kind: 'model', name: `reasoning:agent-${mode}`, status: 'error', severity: 'warn', usage: 'reasoning', durationMs: Date.now() - started, error: { message: (err as Error).message } })
    }
  }

  publishActivity({ type: 'state', state: 'idle' })
  yield { type: 'done' }
}
