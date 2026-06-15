// server/lib/agent/ai-tools.ts
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AgentTool, ToolContext } from './types'
import { publishActivity } from './bus'
import { registerUndo } from './undo'
import { withSpan } from '../observability/record'

export interface RunHooks {
  signal: AbortSignal
  onEvent: (e:
    | { type: 'tool-start'; name: string; args: Record<string, unknown> }
    | { type: 'tool-result'; name: string; summary: string; undoToken?: string }) => void
}

/** Adapt the agent tool registry into an AI SDK ToolSet (execute = existing handler + bus + undo). */
export function buildAiTools(registry: AgentTool[], hooks: RunHooks): ToolSet {
  const ctx: ToolContext = { signal: hooks.signal }
  const set: ToolSet = {}
  for (const t of registry) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: z.object(t.schema),
      execute: async (input: Record<string, unknown>) => {
        hooks.onEvent({ type: 'tool-start', name: t.name, args: input })
        try {
          const exec = await withSpan(
            { kind: 'tool', name: t.name, request: input as Record<string, unknown> },
            () => t.handler(input, ctx)
          )
          const undoToken = exec.undo ? registerUndo(exec.undo) : undefined
          publishActivity({ type: 'tool', name: t.name, summary: exec.summary, undoToken })
          hooks.onEvent({ type: 'tool-result', name: t.name, summary: exec.summary, undoToken })
          return exec.result
        } catch (err) {
          const summary = `failed: ${t.name}`
          publishActivity({ type: 'tool', name: t.name, summary })
          hooks.onEvent({ type: 'tool-result', name: t.name, summary })
          return { error: (err as Error).message }
        }
      }
    })
  }
  return set
}
