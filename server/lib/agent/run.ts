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

export interface AgentMessage { role: 'system' | 'user' | 'assistant'; content: string }
export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; name: string; summary: string; undoToken?: string; images?: import('./image-embed').DisplayImage[] }
  | { type: 'done' }

// Structural type for the streamText dep: only what runAgent actually uses.
type StreamTextFn = (args: never) => { fullStream: AsyncIterable<unknown> }

export interface RunDeps {
  streamText?: StreamTextFn
  tools?: AgentTool[]
  buildSystemPrompt?: (o: { profile?: { personaKey: string; id?: string }; speak: boolean; context?: string }) => Promise<string>
}

/**
 * Filter tools from the base registry. When execEnabled is false (the default),
 * the 'exec' tool is stripped out — exec is dark until the user arms it via the
 * per-session cookie. Pure function so it can be unit-tested independently.
 */
export function effectiveTools(base: AgentTool[], execEnabled: boolean): AgentTool[] {
  if (execEnabled) return base
  return base.filter(t => t.name !== 'exec')
}

export async function* runAgent(
  messages: AgentMessage[],
  ctx: { signal: AbortSignal; speak?: boolean; profile?: AgentProfile; context?: string; execEnabled?: boolean; requestApproval?: (req: import('./types').ApprovalRequest) => Promise<{ approved: boolean }> },
  deps: RunDeps = {}
): AsyncGenerator<AgentEvent> {
  const streamTextFn = (deps.streamText ?? realStreamText) as StreamTextFn
  const profile = ctx.profile ?? bridgetProfile
  const baseRegistry = deps.tools ?? profile.tools
  const registry = effectiveTools(baseRegistry, ctx.execEnabled === true)
  const buildPrompt = deps.buildSystemPrompt ?? realBuildSystemPrompt
  const queue: AgentEvent[] = []
  const tools = buildAiTools(registry, { signal: ctx.signal, requestApproval: ctx.requestApproval, onEvent: e => queue.push(e) })

  // Compute the system prompt ONCE before the model loop (the persona + live
  // context are stable for the turn; the loop only retries model construction).
  const system = await buildPrompt({ profile, speak: ctx.speak ?? false, context: ctx.context })

  publishActivity({ type: 'state', state: 'thinking' })

  // Build the stream, trying each reasoning model in priority order. If stream
  // creation throws (bad baseURL, adapter construction), fall over to the next.
  // Mid-stream failures are NOT retried.
  const models = deps.streamText ? [undefined as never] : await reasoningModels()
  let result: ReturnType<typeof realStreamText> | undefined
  let lastErr: unknown
  for (let i = 0; i < models.length; i++) {
    const model = models[i]!
    const started = Date.now()
    try {
      result = (streamTextFn as unknown as typeof realStreamText)({
        model,
        system,
        // Redact /api/images URLs from history so the model can't copy a real URL into a
        // new reply (which would render the wrong/old image live). See image-embed.ts.
        messages: messages.filter(m => m.role !== 'system').map(m => m.role === 'assistant' ? { ...m, content: redactImageUrlsForModel(m.content) } : m),
        tools,
        stopWhen: stepCountIs(ctx.execEnabled ? VOICE_TUNING.agent.maxStepsPowerful : VOICE_TUNING.agent.maxSteps),
        abortSignal: ctx.signal
      })
      recordEvent({ kind: 'attempt', name: 'reasoning:agent', status: 'ok', severity: 'info', usage: 'reasoning', provider: (model as { label?: string } | undefined)?.label ?? null, modelId: (model as { modelId?: string } | undefined)?.modelId ?? null, attempt: i, durationMs: Date.now() - started })
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

  for await (const part of result.fullStream) {
    while (queue.length) yield queue.shift()!
    if ((part as { type?: unknown }).type === 'text-delta') {
      // AI SDK v6: text-delta part has `text`; test fakes use `delta` — accept both.
      const p = part as { delta?: string; text?: string }
      const text = p.delta ?? p.text ?? ''
      if (text) yield { type: 'text-delta', text }
    }
    // tool-start / tool-result surface via the queue (buildAiTools.onEvent)
  }
  while (queue.length) yield queue.shift()!
  publishActivity({ type: 'state', state: 'idle' })
  yield { type: 'done' }
}
