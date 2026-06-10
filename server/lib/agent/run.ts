// server/lib/agent/run.ts
import { streamText as realStreamText, stepCountIs } from 'ai'
import { reasoningModels } from './model'
import { buildAiTools } from './ai-tools'
import { agentTools as realRegistry } from './tools'
import { buildSystemPrompt } from './prompt'
import { publishActivity } from './bus'
import { VOICE_TUNING } from '../voice/tuning'
import type { AgentTool } from './types'

export interface AgentMessage { role: 'system' | 'user' | 'assistant'; content: string }
export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; name: string; summary: string; undoToken?: string }
  | { type: 'done' }

// Structural type for the streamText dep: only what runAgent actually uses.
type StreamTextFn = (args: never) => { fullStream: AsyncIterable<unknown> }

export interface RunDeps { streamText?: StreamTextFn; tools?: AgentTool[] }

export async function* runAgent(
  messages: AgentMessage[],
  ctx: { signal: AbortSignal; voice?: boolean },
  deps: RunDeps = {}
): AsyncGenerator<AgentEvent> {
  const streamTextFn = (deps.streamText ?? realStreamText) as StreamTextFn
  const registry = deps.tools ?? realRegistry
  const queue: AgentEvent[] = []
  const tools = buildAiTools(registry, { signal: ctx.signal, onEvent: e => queue.push(e) })

  publishActivity({ type: 'state', state: 'thinking' })

  // Build the stream, trying each reasoning model in priority order. If stream
  // creation throws (bad baseURL, adapter construction), fall over to the next.
  // Mid-stream failures are NOT retried.
  const models = deps.streamText ? [undefined as never] : await reasoningModels()
  let result: ReturnType<typeof realStreamText> | undefined
  let lastErr: unknown
  for (const model of models) {
    try {
      result = (streamTextFn as unknown as typeof realStreamText)({
        model,
        system: buildSystemPrompt(ctx.voice ?? false),
        messages: messages.filter(m => m.role !== 'system'),
        tools,
        stopWhen: stepCountIs(VOICE_TUNING.agent.maxSteps),
        abortSignal: ctx.signal
      })
      break
    } catch (err) { lastErr = err }
  }
  if (!result) throw lastErr ?? new Error('no reasoning model available')

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
