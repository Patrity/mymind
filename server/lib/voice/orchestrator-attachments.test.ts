import { describe, it, expect } from 'vitest'
import { handleTurn } from './orchestrator'
import type { AgentEvent } from '../agent/run'

const tts = { synthesize: async function* () {} }

describe('handleTurn — multimodal attachments', () => {
  it('builds an image part for an image attachment and threads attachmentImageIds into the run ctx', async () => {
    let captured: { messages: any[]; ctx: any } | null = null
    const fakeRun = (messages: any[], ctx: any): AsyncGenerator<AgentEvent> => {
      captured = { messages, ctx }
      return (async function* () { yield { type: 'text-delta', text: 'ok' } as AgentEvent })()
    }
    const ac = new AbortController()
    await handleTurn('look at this', [], {
      tts: tts as never, voice: '', signal: ac.signal, speak: false,
      emit: () => {},
      attachments: [{ id: 'img1', kind: 'image', mime: 'image/webp' }],
      readAttachmentBytes: async () => ({ bytes: Buffer.from([1, 2, 3]), mime: 'image/webp' }),
      runAgent: fakeRun as never
    })
    const userMsg = captured!.messages[captured!.messages.length - 1]
    expect(Array.isArray(userMsg.content)).toBe(true)
    expect(userMsg.content.some((p: any) => p.type === 'image')).toBe(true)
    expect(captured!.ctx.attachmentImageIds).toEqual(['img1'])
  })

  it('text-only turn is unchanged (plain string content, no attachmentImageIds)', async () => {
    let captured: { messages: any[]; ctx: any } | null = null
    const fakeRun = (messages: any[], ctx: any): AsyncGenerator<AgentEvent> => {
      captured = { messages, ctx }
      return (async function* () { yield { type: 'text-delta', text: 'ok' } as AgentEvent })()
    }
    const ac = new AbortController()
    await handleTurn('hi', [], { tts: tts as never, voice: '', signal: ac.signal, speak: false, emit: () => {}, runAgent: fakeRun as never })
    const userMsg = captured!.messages[captured!.messages.length - 1]
    expect(userMsg.content).toBe('hi')
    expect(captured!.ctx.attachmentImageIds).toEqual([])
  })
})
