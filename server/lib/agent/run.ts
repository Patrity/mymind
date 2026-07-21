// server/lib/agent/run.ts
import { streamText as realStreamText, stepCountIs } from 'ai'
import { reasoningModels } from './model'
import { buildAiTools } from './ai-tools'
import { buildSystemPrompt as realBuildSystemPrompt } from './prompt'
import { bridgetProfile, type AgentProfile } from './profile'
import { publishActivity } from './bus'
import { VOICE_TUNING } from '../voice/tuning'
import type { AgentTool } from './types'
import { recordEvent } from '../observability/record'
import { redactImageUrlsForModel } from './image-embed'

export type { AgentContentPart } from './types'
import type { AgentContentPart } from './types'

export interface AgentMessage { role: 'system' | 'user' | 'assistant'; content: string | AgentContentPart[] }

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

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-start'; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; name: string; summary: string; undoToken?: string; images?: import('./image-embed').DisplayImage[] }
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

// Structural type for the streamText dep: only what runAgent actually uses.
type StreamTextFn = (args: never) => { fullStream: AsyncIterable<unknown> }

export interface RunDeps {
  streamText?: StreamTextFn
  tools?: AgentTool[]
  buildSystemPrompt?: (o: { profile?: { personaKey: string; id?: string }; speak: boolean; context?: string }) => Promise<string>
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
  const queue: AgentEvent[] = []
  const tools = buildAiTools(registry, { signal: ctx.signal, requestApproval: ctx.requestApproval, attachmentImageIds: ctx.attachmentImageIds, onEvent: e => queue.push(e) })

  // Compute the system prompt ONCE before the model loop (the persona + live
  // context are stable for the turn; the loop only retries model construction).
  const system = await buildPrompt({ profile, speak: ctx.speak ?? false, context: ctx.context })
  const maxSteps = ctx.maxSteps ?? VOICE_TUNING.agent.maxSteps

  publishActivity({ type: 'state', state: 'thinking' })

  // Redact /api/images URLs from history so the model can't copy a real URL into a
  // new reply (which would render the wrong/old image live). See image-embed.ts.
  // Reused verbatim by the forced-final follow-up below.
  const modelMessages = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: toModelContent(m.role, m.content) }))

  // Build the stream, trying each reasoning model in priority order. If stream
  // creation throws (bad baseURL, adapter construction), fall over to the next.
  // Mid-stream failures are NOT retried.
  const models = deps.streamText ? [undefined as never] : await reasoningModels(ctx.modelDefId)
  let result: ReturnType<typeof realStreamText> | undefined
  let chosen: (typeof models)[number] | undefined
  let lastErr: unknown
  for (let i = 0; i < models.length; i++) {
    const model = models[i]!
    const started = Date.now()
    try {
      result = (streamTextFn as unknown as typeof realStreamText)({
        model,
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
  for await (const part of result.fullStream) {
    while (queue.length) yield queue.shift()!
    if ((part as { type?: unknown }).type === 'tool-call') sawToolCall = true
    // tool-start / tool-result surface via the queue (buildAiTools.onEvent)
    const ev = partToEvent(part)
    if (ev) { if (ev.type === 'text-delta') sawText = true; yield ev }
  }
  while (queue.length) yield queue.shift()!

  // Final-answer guarantee. The step-cap guard (prepareStep) forces a text-only
  // LAST step, but a reasoning model can VOLUNTARILY stop after a tool call —
  // emitting only tool calls / reasoning and no text, well before the cap — and
  // the AI SDK loop ends there. That turn would otherwise yield no reply at all
  // (live failure: "What'd we work on yesterday?" ran search_docs + list_documents
  // then went silent). If tools ran but no text was produced, re-run ONCE with
  // toolChoice:'none', feeding back the tool results, to force a spoken answer.
  if (!sawText && sawToolCall && !ctx.signal.aborted) {
    const started = Date.now()
    try {
      const prior = ((await result.response) as { messages?: unknown[] }).messages ?? []
      const followup = (streamTextFn as unknown as typeof realStreamText)({
        model: chosen as never,
        system,
        messages: [...modelMessages, ...prior] as never,
        tools,
        toolChoice: 'none',
        temperature: VOICE_TUNING.agent.temperature,
        abortSignal: ctx.signal
      })
      for await (const part of followup.fullStream) {
        while (queue.length) yield queue.shift()!
        const ev = partToEvent(part)
        if (ev) { if (ev.type === 'text-delta') sawText = true; yield ev }
      }
      while (queue.length) yield queue.shift()!
      recordEvent({ kind: 'attempt', name: 'reasoning:agent-forced-final', status: sawText ? 'ok' : 'warn', severity: sawText ? 'info' : 'warn', usage: 'reasoning', modelId: (chosen as { modelId?: string } | undefined)?.modelId ?? null, durationMs: Date.now() - started })
    } catch (err) {
      recordEvent({ kind: 'model', name: 'reasoning:agent-forced-final', status: 'error', severity: 'warn', usage: 'reasoning', durationMs: Date.now() - started, error: { message: (err as Error).message } })
    }
  }

  publishActivity({ type: 'state', state: 'idle' })
  yield { type: 'done' }
}
