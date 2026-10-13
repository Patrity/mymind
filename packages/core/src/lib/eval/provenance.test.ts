import { describe, it, expect } from 'vitest'
import { gatewayAllow, gatewayOriginsFrom, gitSha, runPromptHash, sha256, toolsHashOf } from './provenance'
import { emptyDoc, type AiConfigDoc } from '../ai/registry/types'

describe('gitSha', () => {
  it('MYMIND_GIT_SHA first, then git rev-parse, then unknown', async () => {
    expect(await gitSha({ env: { MYMIND_GIT_SHA: 'abc1234' }, revParse: async () => 'def5678' })).toBe('abc1234')
    expect(await gitSha({ env: {}, revParse: async () => 'def5678' })).toBe('def5678')
    expect(await gitSha({ env: { MYMIND_GIT_SHA: '  ' }, revParse: async () => null })).toBe('unknown')
    expect(await gitSha({ env: {}, revParse: async () => { throw new Error('no git') } })).toBe('unknown')
  })
})

describe('hashes', () => {
  it('tools hash: order-independent, changes with a description', () => {
    const a = [{ name: 'b', description: 'B' }, { name: 'a', description: 'A' }]
    expect(toolsHashOf(a)).toBe(toolsHashOf([...a].reverse()))
    expect(toolsHashOf(a)).not.toBe(toolsHashOf([{ name: 'b', description: 'B2' }, { name: 'a', description: 'A' }]))
    expect(toolsHashOf(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('run prompt hash is order-independent over cases', () => {
    expect(runPromptHash({ x: sha256('1'), y: sha256('2') })).toBe(runPromptHash({ y: sha256('2'), x: sha256('1') }))
    expect(runPromptHash({ x: sha256('1') })).not.toBe(runPromptHash({ x: sha256('2') }))
  })
})

describe('gateway allow-list', () => {
  const doc: AiConfigDoc = {
    ...emptyDoc(),
    providers: [
      { id: 'p1', kind: 'openai-compatible', label: 'gw', baseURL: 'http://gw.lan:4000/v1', apiKeyEnc: null },
      { id: 'p2', kind: 'openai-compatible', label: 'judge', baseURL: 'https://judge.example/v1', apiKeyEnc: null },
      { id: 'p3', kind: 'openai-compatible', label: 'unused', baseURL: 'https://unused.example', apiKeyEnc: null }
    ] as never,
    models: [
      { id: 'm1', providerId: 'p1', modelId: 'r', label: 'R', dim: null, maxInFlight: null },
      { id: 'm2', providerId: 'p2', modelId: 'j', label: 'J', dim: null, maxInFlight: null },
      { id: 'm3', providerId: 'p3', modelId: 'u', label: 'U', dim: null, maxInFlight: null }
    ] as never,
    assignments: { ...emptyDoc().assignments, reasoning: ['m1'], judge: ['m2'], bulk: ['m3'] }
  }

  it('only the origins of the reasoning / subagents / judge providers', () => {
    expect([...gatewayOriginsFrom(doc)].sort()).toEqual(['http://gw.lan:4000', 'https://judge.example'])
  })

  it('compares the PARSED origin exactly — never a prefix', () => {
    const allow = gatewayAllow(gatewayOriginsFrom(doc))
    expect(allow('http://gw.lan:4000/v1/chat/completions')).toBe(true)
    expect(allow('https://judge.example/v1/x')).toBe(true)
    expect(allow('http://gw.lan:4000.evil.net/v1')).toBe(false)
    expect(allow('http://gw.lan:4000@evil.net/v1')).toBe(false)
    expect(allow('http://gw.lan.evil.net:4000/v1')).toBe(false)
    expect(allow('http://gw.lan:40001/v1')).toBe(false) // a longer port shares the prefix
    expect(allow('https://judge.example.evil.net/x')).toBe(false) // a longer host shares the prefix
    expect(allow('https://gw.lan:4000/v1')).toBe(false) // scheme differs
    expect(allow('http://gw.lan:4001/v1')).toBe(false) // port differs
    expect(allow('http://user:pw@gw.lan:4000/v1')).toBe(false) // credentials in the URL
    expect(allow('https://unused.example/')).toBe(false)
    expect(allow('not a url')).toBe(false)
  })
})
