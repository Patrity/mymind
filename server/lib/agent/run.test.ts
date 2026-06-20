// server/lib/agent/run.test.ts
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { effectiveTools } from './run'
import type { AgentTool } from './types'

function makeTool(name: string): AgentTool {
  return {
    name,
    description: `${name} tool`,
    schema: { input: z.string() },
    kind: 'read',
    handler: async () => ({ result: null, summary: '' }),
  }
}

describe('effectiveTools', () => {
  const execTool = makeTool('exec')
  const readTool = makeTool('read_file')
  const searchTool = makeTool('search')
  const base = [readTool, execTool, searchTool]

  it('includes exec when execEnabled=true', () => {
    const result = effectiveTools(base, true)
    expect(result).toHaveLength(3)
    expect(result.some(t => t.name === 'exec')).toBe(true)
  })

  it('excludes exec when execEnabled=false', () => {
    const result = effectiveTools(base, false)
    expect(result).toHaveLength(2)
    expect(result.some(t => t.name === 'exec')).toBe(false)
  })

  it('returns all tools unchanged when no exec tool present and execEnabled=false', () => {
    const noExec = [readTool, searchTool]
    const result = effectiveTools(noExec, false)
    expect(result).toHaveLength(2)
    expect(result).toEqual(noExec)
  })

  it('returns the same array reference when execEnabled=true (no copy)', () => {
    const result = effectiveTools(base, true)
    expect(result).toBe(base)
  })
})
