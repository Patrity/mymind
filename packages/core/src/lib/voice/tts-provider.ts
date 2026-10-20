// Which TTS engine speaks. Two adapters share one request/stream contract (breeze.ts and
// audiocpp.ts); this module is the only place that knows there are two, so the rest of the
// voice stack stays provider-blind. Pure — it reads no config itself. The app-wired speaker
// (speak.ts) and the studio route feed it `coreConfig().ttsProvider`.
import { breezeSpeak, type SpeakFn } from './breeze'
import { audiocppSpeak, AUDIOCPP_DESIGN_PROMPT_BUDGET } from './audiocpp'
import { DESIGN_PROMPT_BUDGET } from '../../shared/types/voice-presets'

export const TTS_PROVIDERS = ['breeze', 'audiocpp'] as const
export type TtsProviderId = (typeof TTS_PROVIDERS)[number]

/** What production runs today. An unset switch must change nothing. */
export const DEFAULT_TTS_PROVIDER: TtsProviderId = 'breeze'

/**
 * `AI_TTS_PROVIDER` → provider. Unknown values fall back to the default rather than throwing:
 * this is read while building CoreConfig, where a throw takes the whole process down over a
 * typo, and the default is the engine that was serving before the variable existed.
 */
export function parseTtsProvider(raw: string | null | undefined): TtsProviderId {
  const v = raw?.trim().toLowerCase()
  return v === 'audiocpp' ? 'audiocpp' : DEFAULT_TTS_PROVIDER
}

export function speakFnFor(provider: TtsProviderId): SpeakFn {
  return provider === 'audiocpp' ? audiocppSpeak : breezeSpeak
}

/**
 * The single-call text budget for a REFERENCE-FREE preset on this provider. Reference-backed
 * presets keep their calibrated `maxSegmentChars` regardless (see maxCallChars).
 *
 * The override only applies to audio.cpp: Breeze-Python's 950 is a measurement of where its
 * model breaks (plan-segments.ts), not a tunable.
 */
export function designPromptBudgetFor(provider: TtsProviderId, audiocppOverride?: number | null): number {
  if (provider !== 'audiocpp') return DESIGN_PROMPT_BUDGET
  const o = audiocppOverride
  return typeof o === 'number' && Number.isFinite(o) && o > 0 ? Math.floor(o) : AUDIOCPP_DESIGN_PROMPT_BUDGET
}
