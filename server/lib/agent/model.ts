// server/lib/agent/model.ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { aiProvider } from '../ai/provider'

/** AI SDK language model for the `reasoning` role (local qwen via vLLM, OpenAI-spec). */
export function reasoningModel() {
  const cfg = aiProvider('reasoning', { required: true })
  const provider = createOpenAICompatible({
    name: 'mymind-reasoning',
    baseURL: cfg.baseURL!.replace(/\/$/, ''),
    apiKey: cfg.apiKey || 'none'
  })
  return provider(cfg.model || 'default')
}
