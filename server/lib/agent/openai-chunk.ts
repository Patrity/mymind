// server/lib/agent/openai-chunk.ts
export function textChunk(content: string): string {
  const chunk = {
    id: 'mymind-agent', object: 'chat.completion.chunk', created: 0, model: 'mymind-agent',
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}
export function doneFrame(): string {
  return 'data: [DONE]\n\n'
}
