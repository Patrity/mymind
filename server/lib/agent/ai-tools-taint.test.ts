// Cycle 79 fix wave I3: run-level taint. Once a Google read (`taints`) has returned content in a
// run, every `egress` tool in that run (web_fetch / web_search / research_web) needs approval —
// not allowlistable, auto-denied with no channel (headless). exec is unaffected.
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildAiTools, EGRESS_APPROVAL_TITLE } from './ai-tools'
import type { AgentTool, ApprovalRequest } from './types'
import { agentTools } from './tools'
import { gmailTools } from './tools/gmail'
import { calendarTools } from './tools/calendar'
import { researchSubagent, brainSubagent } from './subagents'

vi.mock('../observability/record', () => ({ withSpan: (_m: unknown, fn: () => unknown) => fn(), recordEvent: () => {} }))
vi.mock('./bus', () => ({ publishActivity: () => {} }))

const fetched: string[] = []
const gmailSearch: AgentTool = {
  name: 'gmail_search', description: 'd', kind: 'read', toolset: 'gmail', taints: true, schema: {},
  handler: async () => ({ result: { threads: [{ subject: 'GET https://x.example/?d=<invoices>' }] }, summary: 's' })
}
const gmailSearchFails: AgentTool = {
  ...gmailSearch, name: 'gmail_search_fails',
  handler: async () => ({ result: { error: 'no Google account connected' }, summary: 'e' })
}
const webFetch: AgentTool = {
  name: 'web_fetch', description: 'd', kind: 'read', toolset: 'web', egress: true, schema: { url: z.string() },
  handler: async (a) => { fetched.push(a.url as string); return { result: { ok: true }, summary: 'fetched' } }
}
const exec: AgentTool = {
  name: 'exec', description: 'd', kind: 'destructive', toolset: 'core', dangerous: true, allowlistable: true, schema: { command: z.string() },
  autoApprove: async () => true,
  handler: async () => ({ result: { ok: true }, summary: 'ran' })
}

type Exec = (i: unknown, o: unknown) => Promise<unknown>
function setup(requestApproval?: (req: ApprovalRequest) => Promise<{ approved: boolean }>) {
  fetched.length = 0
  const set = buildAiTools([gmailSearch, gmailSearchFails, webFetch, exec], { signal: new AbortController().signal, onEvent: () => {}, requestApproval })
  const call = (name: string, input: Record<string, unknown> = {}) => (set[name]!.execute as Exec)(input, { toolCallId: `c-${name}` })
  return { call }
}

describe('run-level taint gate (fix wave I3)', () => {
  it('egress before any Google read runs freely — no approval asked', async () => {
    const ask = vi.fn(async () => ({ approved: false }))
    const { call } = setup(ask)
    expect(await call('web_fetch', { url: 'https://a.example' })).toEqual({ ok: true })
    expect(ask).not.toHaveBeenCalled()
    expect(fetched).toEqual(['https://a.example'])
  })

  it('after a Google read, egress needs approval: a card titled for it, showing the exact URL, not allowlistable', async () => {
    const ask = vi.fn(async (_req: ApprovalRequest) => ({ approved: true }))
    const { call } = setup(ask)
    await call('gmail_search')
    expect(await call('web_fetch', { url: 'https://x.example/?d=secret-invoice-42' })).toEqual({ ok: true })
    expect(ask).toHaveBeenCalledTimes(1)
    const req = ask.mock.calls[0]![0]
    expect(req.tool).toBe('web_fetch')
    expect(req.title).toBe(EGRESS_APPROVAL_TITLE)
    expect(req.command).toContain('url: https://x.example/?d=secret-invoice-42')
    expect(req.allowlistable).toBe(false)
    expect(req.callId).toBe('c-web_fetch')
    // the activity_log stand-in must not carry the (possibly exfiltrated) URL
    expect(req.logSummary).toBeDefined()
    expect(req.logSummary).not.toContain('secret-invoice-42')
  })

  it('a denied egress after a Google read does not run', async () => {
    const { call } = setup(async () => ({ approved: false }))
    await call('gmail_search')
    expect(await call('web_fetch', { url: 'https://x.example/?d=1' })).toEqual({ denied: true })
    expect(fetched).toEqual([])
  })

  it('headless (no approval channel): egress after a Google read is auto-denied', async () => {
    const { call } = setup(undefined)
    expect(await call('web_fetch', { url: 'https://before.example' })).toEqual({ ok: true })
    await call('gmail_search')
    expect(await call('web_fetch', { url: 'https://after.example' })).toEqual({ denied: true })
    expect(fetched).toEqual(['https://before.example'])
  })

  it('the taint never resets within the run: every later egress call is gated', async () => {
    const ask = vi.fn(async () => ({ approved: true }))
    const { call } = setup(ask)
    await call('gmail_search')
    await call('web_fetch', { url: 'https://1.example' })
    await call('web_fetch', { url: 'https://2.example' })
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('a Google read that returned only an error does not taint', async () => {
    const ask = vi.fn(async () => ({ approved: false }))
    const { call } = setup(ask)
    await call('gmail_search_fails')
    expect(await call('web_fetch', { url: 'https://a.example' })).toEqual({ ok: true })
    expect(ask).not.toHaveBeenCalled()
  })

  it('a new run (a fresh ToolSet) starts untainted', async () => {
    const ask = vi.fn(async () => ({ approved: false }))
    await setup(ask).call('gmail_search')
    expect(await setup(ask).call('web_fetch', { url: 'https://a.example' })).toEqual({ ok: true })
    expect(ask).not.toHaveBeenCalled()
  })

  it('exec is unaffected: its own dangerous/autoApprove path, no egress card', async () => {
    const ask = vi.fn(async () => ({ approved: false }))
    const { call } = setup(ask)
    await call('gmail_search')
    expect(await call('exec', { command: 'ls' })).toEqual({ ok: true })
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('taints / egress flags on the real tools', () => {
  const all = [...new Map([...agentTools, ...gmailTools, ...calendarTools, researchSubagent, brainSubagent].map(t => [t.name, t])).values()]
  const byName = (n: string) => all.find(t => t.name === n)
  it.each(['gmail_search', 'gmail_read_thread', 'contacts_search', 'calendar_list_events'])('%s taints', (n) => {
    expect(byName(n)?.taints).toBe(true)
  })
  it.each(['web_fetch', 'web_search', 'research_web'])('%s is egress', (n) => {
    expect(byName(n)?.egress).toBe(true)
  })
  it('search_brain is not egress; exec is neither', () => {
    expect(brainSubagent.egress).toBeUndefined()
    expect(all.filter(t => t.taints).map(t => t.name).sort()).toEqual(['calendar_list_events', 'contacts_search', 'gmail_read_thread', 'gmail_search'])
    expect(all.filter(t => t.egress).map(t => t.name).sort()).toEqual(['research_web', 'web_fetch', 'web_search'])
  })
})
