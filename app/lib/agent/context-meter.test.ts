import { describe, it, expect } from 'vitest'
import { contextMeterData } from './context-meter'
import type { AgentUIMessage } from '~~/shared/types/agent-ui'

const a = (id: string, usage?: object): AgentUIMessage => ({ id, role: 'assistant', parts: [], metadata: usage ? { usage } : {} })
const models = [{ id: 'haiku', contextWindow: 200000 }, { id: 'qwen', contextWindow: null }]

describe('contextMeterData', () => {
  it('uses the latest assistant message that reported contextTokens, and its model\'s window', () => {
    const d = contextMeterData([a('1', { contextTokens: 10, modelDefId: 'qwen' }), a('2', { contextTokens: 42000, modelDefId: 'haiku' })], models, [])
    expect(d).toEqual({ usedTokens: 42000, maxTokens: 200000, modelDefId: 'haiku' })
  })
  it('falls back to the selected / chain-head model when the message has no modelDefId', () => {
    expect(contextMeterData([a('1', { contextTokens: 5 })], models, [null, 'haiku'])).toEqual({ usedTokens: 5, maxTokens: 200000, modelDefId: 'haiku' })
  })
  it('unknown window → maxTokens null', () => {
    expect(contextMeterData([a('1', { contextTokens: 5, modelDefId: 'qwen' })], models, [])!.maxTokens).toBeNull()
  })
  it('no usage yet (or only legacy usage without contextTokens) → null', () => {
    expect(contextMeterData([], models, [])).toBeNull()
    expect(contextMeterData([a('1', { totalTokens: 99 })], models, [])).toBeNull()
  })
})
