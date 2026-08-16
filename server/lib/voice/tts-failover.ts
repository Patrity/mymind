// server/lib/voice/tts-failover.ts
import { resolveChain, reorderChain, withFailoverOver } from '../ai/registry/resolve'
import type { ResolvedModel } from '../ai/registry/types'
import type { SpanInput } from '../observability/types'
import { ttsFromModel as realTtsFromModel } from './providers'
import type { TtsProvider } from './providers/types'

export interface TtsSynthDeps {
  resolveChain: () => Promise<ResolvedModel[]>
  ttsFromModel: (m: ResolvedModel) => TtsProvider
  /** Optional observability seam (tests inject a no-op; the app uses the default recorder). */
  obs?: { recordEvent: (e: SpanInput) => void }
}

/**
 * Pure: put the TTS model whose label matches the chosen provider at the head of the
 * chain (the rest stay as failover). The voice picker (`/api/voice/voices`) aggregates
 * voices from EVERY tts provider and tags each with the model label, so a chosen voice
 * only exists on ONE provider — dialing the chain head with another provider's voice
 * name is a guaranteed 400 (Kokoro: "Voice 'X' not found") that then fails over. Unknown
 * or absent provider → registry order (legacy clients that only send `voice`).
 */
export function pinChainToProvider(chain: ResolvedModel[], provider?: string | null): ResolvedModel[] {
  if (!provider) return chain
  const hit = chain.find(m => m.label === provider)
  return hit ? reorderChain(chain, hit.modelDefId) : chain
}

/**
 * Build the per-utterance TTS synthesizer used by the voice socket. tts-openai buffers
 * the whole WAV per call, so all chunks are collected INSIDE the failover — a provider
 * that errors on synthesis falls over to the next, and only a fully-synthesized result
 * is yielded. (Failover is per utterance, not mid-stream.)
 */
export function createTtsSynth(deps: TtsSynthDeps): TtsProvider['synthesize'] {
  return async function* synthesize(text, opts) {
    const chain = pinChainToProvider(await deps.resolveChain(), opts.provider)
    const chunks = await withFailoverOver('tts', chain, async (m) => {
      const out: Uint8Array[] = []
      for await (const c of deps.ttsFromModel(m).synthesize(text, opts)) out.push(c)
      return out
    }, deps.obs)
    yield* chunks
  }
}

/** App-wired synthesizer: registry chain + real OpenAI-spec providers + default recorder. */
export const ttsSynth: TtsProvider['synthesize'] = createTtsSynth({
  resolveChain: () => resolveChain('tts'),
  ttsFromModel: realTtsFromModel
})
