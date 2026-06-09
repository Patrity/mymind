// server/lib/agent/loop.ts
import type { ChatMessage } from '../ai/chat'
import { streamChat as realStreamChat, zodShapeToJsonSchema, type OpenAiToolDef } from '../ai/chat-stream'
import { agentTools as realTools } from './tools'
import { buildSystemPrompt } from './prompt'
import { publishActivity } from './bus'
import { registerUndo } from './undo'
import type { AgentTool, LoopEvent, ToolContext } from './types'

const FILLERS = ['One sec…', 'Let me check…', 'Looking that up…', 'On it…']
const MAX_ROUNDS = 5

// Internal message union covering all roles used in the OpenAI tool-calling wire format.
// ChatMessage only allows 'system'|'user'|'assistant' — the loop also needs 'tool' messages
// and assistant messages with a `tool_calls` array, neither of which are part of that type.
interface AssistantToolCallMessage {
  role: 'assistant'
  content: string
  tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}
interface ToolResultMessage {
  role: 'tool'
  content: string
  tool_call_id: string
  name: string
}
type LoopMessage = ChatMessage | AssistantToolCallMessage | ToolResultMessage

export interface LoopDeps {
  streamChat?: typeof realStreamChat
  tools?: AgentTool[]
}

export async function* runAgentLoop(
  incoming: ChatMessage[],
  ctx: ToolContext,
  deps: LoopDeps = {}
): AsyncGenerator<LoopEvent> {
  const streamChat = deps.streamChat ?? realStreamChat
  const tools = deps.tools ?? realTools
  const byName = new Map(tools.map(t => [t.name, t]))
  const toolDefs: OpenAiToolDef[] = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: zodShapeToJsonSchema(t.schema) }
  }))

  // Replace any inbound system message with ours (the loop owns persona + policy).
  const userTurns = incoming.filter(m => m.role !== 'system')
  const messages: LoopMessage[] = [{ role: 'system', content: buildSystemPrompt() }, ...userTurns]

  let fillerSpoken = false

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (ctx.signal.aborted) return
    let toolCalls: { id: string; name: string; args: Record<string, unknown> }[] | undefined
    let sawText = false

    // Cast through unknown once at the streamChat boundary — LoopMessage is a superset
    // of ChatMessage (adds 'tool' role + tool_calls) and is wire-compatible with OpenAI.
    for await (const chunk of streamChat('reasoning', messages as unknown as ChatMessage[], { tools: toolDefs, signal: ctx.signal })) {
      if (chunk.textDelta) { sawText = true; yield { type: 'text-delta', text: chunk.textDelta } }
      if (chunk.toolCalls) toolCalls = chunk.toolCalls
    }

    if (!toolCalls || toolCalls.length === 0) {
      publishActivity({ type: 'state', state: 'idle' })
      yield { type: 'done' }
      return
    }

    if (!sawText && !fillerSpoken) {
      fillerSpoken = true
      yield { type: 'text-delta', text: FILLERS[round % FILLERS.length] + ' ' }
    }
    publishActivity({ type: 'state', state: 'tool' })

    // Append assistant turn with tool_calls (OpenAI wire format).
    const assistantTurn: AssistantToolCallMessage = {
      role: 'assistant',
      content: '',
      tool_calls: toolCalls.map(c => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) }
      }))
    }
    messages.push(assistantTurn)

    for (const call of toolCalls) {
      const tool = byName.get(call.name)
      yield { type: 'tool-start', name: call.name, args: call.args }
      let summary = `called ${call.name}`
      let resultText = ''
      let undoToken: string | undefined
      try {
        if (!tool) throw new Error(`unknown tool ${call.name}`)
        const exec = await tool.handler(call.args, ctx)
        summary = exec.summary
        resultText = JSON.stringify(exec.result)
        if (exec.undo) undoToken = registerUndo(exec.undo)
      } catch (err) {
        resultText = JSON.stringify({ error: (err as Error).message })
        summary = `failed: ${call.name}`
      }
      publishActivity({ type: 'tool', name: call.name, summary, undoToken })
      yield { type: 'tool-result', name: call.name, summary, undoToken }
      // Append tool result turn (OpenAI wire format).
      const toolResultMsg: ToolResultMessage = {
        role: 'tool',
        content: resultText,
        tool_call_id: call.id,
        name: call.name
      }
      messages.push(toolResultMsg)
    }
  }

  publishActivity({ type: 'state', state: 'idle' })
  yield { type: 'done' }
}
