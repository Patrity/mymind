// server/lib/agent/run.ts
import { streamText as realStreamText, stepCountIs } from 'ai'
import { reasoningModel } from './model'
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
  ctx: { signal: AbortSignal },
  deps: RunDeps = {}
): AsyncGenerator<AgentEvent> {
  const streamTextFn = (deps.streamText ?? realStreamText) as StreamTextFn
  const registry = deps.tools ?? realRegistry
  const queue: AgentEvent[] = []
  const tools = buildAiTools(registry, { signal: ctx.signal, onEvent: e => queue.push(e) })

  // Only resolve the real model when the real streamText is in use; injected
  // fakes ignore their args so we skip the Nuxt useRuntimeConfig() call.
  const model = deps.streamText ? (undefined as never) : reasoningModel()

  publishActivity({ type: 'state', state: 'thinking' })
  const result = (streamTextFn as unknown as typeof realStreamText)({
    model,
    system: buildSystemPrompt(),
    messages: messages.filter(m => m.role !== 'system'),
    tools,
    stopWhen: stepCountIs(VOICE_TUNING.agent.maxSteps),
    abortSignal: ctx.signal
  })

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
