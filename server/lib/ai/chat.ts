// server/lib/ai/chat.ts
import { withFailover } from './registry/resolve'
import { AiAllFailedError } from './registry/errors'
import type { ResolvedModel, Usage } from './registry/types'

export interface TextPart { type: 'text', text: string }
export interface ImageUrlPart { type: 'image_url', image_url: { url: string } }
export type ContentPart = TextPart | ImageUrlPart

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

interface ChatCompletion { choices?: { message?: { content?: string } }[] }

/**
 * Pull the assistant message out of an OpenAI-style completion, THROWING on any
 * unexpected shape (missing choices, empty content, or a non-JSON body — e.g. an
 * HTML error page returned with HTTP 200). Throwing is deliberate: `chat()` runs
 * inside `withFailover`, which only advances to the next model on a thrown error.
 * Returning '' here would look like success and silently strand the call on a
 * broken provider (this is exactly what masked a misconfigured provider before).
 */
export function extractContent(res: unknown): string {
  const content = (res as ChatCompletion)?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error(EMPTY_REPLY_ERROR)
  }
  return content
}

export const EMPTY_REPLY_ERROR = 'chat: model returned no usable content'

/**
 * True when a chat call failed ONLY because the model(s) answered with empty/blank content —
 * i.e. every attempt in the failover chain got through and replied with nothing. That is a reply
 * about THIS input (a content failure), not an outage. If any attempt failed some other way
 * (5xx, timeout, network), the chain may simply have been down: not this.
 */
export function isEmptyReplyError(err: unknown): boolean {
  if (err instanceof AiAllFailedError) {
    return err.attempts.length > 0 && err.attempts.every(a => a.error === EMPTY_REPLY_ERROR)
  }
  return err instanceof Error && err.message === EMPTY_REPLY_ERROR
}

/** Per-attempt request timeout when the caller names none. */
export const CHAT_TIMEOUT_MS = 60_000

type ChatOpts = { temperature?: number, maxTokens?: number, timeoutMs?: number }

/** One chat-completions POST against one resolved model. Throws on a bad shape (see extractContent). */
async function completeOn(m: ResolvedModel, messages: ChatMessage[], opts: ChatOpts): Promise<string> {
  const res = await $fetch<unknown>(
    `${(m.baseURL ?? '').replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: m.apiKey ? { authorization: `Bearer ${m.apiKey}` } : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? CHAT_TIMEOUT_MS),
      body: { model: m.modelId, messages, temperature: opts.temperature ?? 0.2, max_tokens: opts.maxTokens ?? 600 }
    }
  )
  return extractContent(res)
}

// `role` here is a registry Usage (e.g. 'bulk', 'vision').
// `timeoutMs` bounds each attempt of the failover chain (default CHAT_TIMEOUT_MS): a caller that
// asks for a long output (the reflector's full skill/profile files) needs more than a minute.
export async function chat(role: Usage, messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  return withFailover(role, m => completeOn(m, messages, opts))
}

/**
 * `chat()` that also reports WHICH model answered — the chain member that succeeded, not the
 * chain head, since a failover can land the call anywhere in the chain. For callers that store
 * provenance per row (the memory audit's `audit_model`).
 */
export async function chatWithModel(role: Usage, messages: ChatMessage[], opts: ChatOpts = {}): Promise<{ text: string, model: string }> {
  return withFailover(role, async m => ({ text: await completeOn(m, messages, opts), model: m.modelId }))
}
