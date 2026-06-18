import { chat } from '../ai/chat'
import type { ChatMessage } from '../ai/chat'

const SYS = 'You situate a text chunk within its document for search retrieval. Reply with ONE short sentence (max ~25 words) describing what this chunk is about and where it sits in the document. No preamble.'

export async function contextualizeChunk(opts: {
  doc: string
  chunk: string
  headingPath: string
  enabled: boolean
}): Promise<string> {
  if (!opts.enabled) return opts.headingPath
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYS },
      {
        role: 'user',
        content: `<document>\n${opts.doc}\n</document>\n\n<chunk>\n${opts.chunk}\n</chunk>\n\nGive the one-sentence context for the chunk.`
      }
    ]
    const out = await chat('bulk', messages, { temperature: 0.1, maxTokens: 80 })
    const trimmed = out.trim()
    return trimmed || opts.headingPath
  } catch {
    return opts.headingPath
  }
}
