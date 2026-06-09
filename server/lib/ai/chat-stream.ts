// server/lib/ai/chat-stream.ts
import type { z } from 'zod'
import { aiProvider, type AiRole } from './provider'
import type { ChatMessage } from './chat'

// --- pure helpers (exported for tests) ---

export function parseSseLine(line: string): { done: boolean, json?: unknown } {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(':')) return { done: false }
  if (!trimmed.startsWith('data:')) return { done: false }
  const payload = trimmed.slice(5).trim()
  if (payload === '[DONE]') return { done: true }
  try {
    return { done: false, json: JSON.parse(payload) }
  } catch {
    return { done: false }
  }
}

interface ToolCallAcc { id?: string, name?: string, args: string }
interface ToolCallDelta { index: number, id?: string, function?: { name?: string, arguments?: string } }

export function assembleToolCalls(acc: Record<number, ToolCallAcc>, deltas: ToolCallDelta[]): void {
  for (const d of deltas) {
    const cur = acc[d.index] ?? (acc[d.index] = { args: '' })
    if (d.id) cur.id = d.id
    if (d.function?.name) cur.name = d.function.name
    if (d.function?.arguments) cur.args += d.function.arguments
  }
}

// --- OpenAI tool schema from a zod raw shape ---

export interface OpenAiToolDef {
  type: 'function'
  function: { name: string, description: string, parameters: Record<string, unknown> }
}

// Zod v4 uses `.def.type` as the type discriminator instead of `._def.typeName`.
// Casting through `unknown` here because `.def` is typed as a broad union in Zod v4's
// exported types but the runtime shape is stable and documented above.
export function zodShapeToJsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, schema] of Object.entries(shape)) {
    const s = schema as z.ZodTypeAny
    // Zod v4: use `.def.type` (string) instead of `._def.typeName`
    const rawDef = (s as unknown as { def: { type: string, innerType?: z.ZodTypeAny, entries?: Record<string, string>, element?: z.ZodTypeAny } }).def
    let inner: z.ZodTypeAny = s
    let innerDef = rawDef
    let optional = false
    if (rawDef.type === 'optional') {
      optional = true
      inner = rawDef.innerType!
      innerDef = (inner as unknown as { def: typeof rawDef }).def
    }
    let jsonType: Record<string, unknown> = { type: 'string' }
    if (innerDef.type === 'number') jsonType = { type: 'number' }
    else if (innerDef.type === 'boolean') jsonType = { type: 'boolean' }
    else if (innerDef.type === 'enum') {
      // Zod v4: enum values are in `def.entries` as { value: value } object
      const entries = innerDef.entries ?? {}
      jsonType = { type: 'string', enum: Object.keys(entries) }
    } else if (innerDef.type === 'array') jsonType = { type: 'array', items: { type: 'string' } }
    if (inner.description) jsonType.description = inner.description
    properties[key] = jsonType
    if (!optional) required.push(key)
  }
  return { type: 'object', properties, required }
}

// --- streaming call ---

export interface StreamChunk {
  textDelta?: string
  toolCalls?: { id: string, name: string, args: Record<string, unknown> }[] // emitted once, at end
}

/**
 * Stream an OpenAI chat completion. Yields `{ textDelta }` as content arrives and,
 * if the model called tools, a final `{ toolCalls }` chunk. Aborts on `signal`.
 */
export async function* streamChat(
  role: AiRole,
  messages: ChatMessage[],
  opts: { tools?: OpenAiToolDef[], signal?: AbortSignal, temperature?: number, maxTokens?: number } = {}
): AsyncGenerator<StreamChunk> {
  const cfg = aiProvider(role, { required: true })
  const res = await fetch(`${cfg.baseURL!.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {})
    },
    signal: opts.signal,
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 800,
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: 'auto' } : {})
    })
  })
  if (!res.ok || !res.body) throw new Error(`stream chat failed: ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const toolAcc: Record<number, ToolCallAcc> = {}
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const parsed = parseSseLine(line)
      if (parsed.done) {
        buffer = ''
        break
      }
      if (!parsed.json) continue
      const choice = (parsed.json as { choices?: { delta?: { content?: string, tool_calls?: ToolCallDelta[] } }[] }).choices?.[0]
      const delta = choice?.delta
      if (delta?.content) yield { textDelta: delta.content }
      if (delta?.tool_calls) assembleToolCalls(toolAcc, delta.tool_calls)
    }
  }

  const calls = Object.values(toolAcc)
  if (calls.length) {
    yield {
      toolCalls: calls.map(c => ({
        id: c.id ?? '', name: c.name ?? '',
        args: c.args ? safeJson(c.args) : {}
      }))
    }
  }
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
