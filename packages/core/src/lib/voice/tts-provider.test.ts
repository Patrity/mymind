import { describe, it, expect } from 'vitest'
import {
  parseTtsProvider, speakFnFor, designPromptBudgetFor, DEFAULT_TTS_PROVIDER
} from './tts-provider'
import { breezeSpeak } from './breeze'
import { audiocppSpeak, AUDIOCPP_DESIGN_PROMPT_BUDGET } from './audiocpp'
import { DESIGN_PROMPT_BUDGET } from '../../shared/types/voice-presets'

describe('parseTtsProvider', () => {
  // Merging this branch must be a no-op until someone flips the switch: an absent variable
  // has to mean the engine production runs today.
  it('defaults to breeze when the variable is absent', () => {
    expect(parseTtsProvider(undefined)).toBe('breeze')
    expect(DEFAULT_TTS_PROVIDER).toBe('breeze')
  })

  it('selects audiocpp when asked', () => {
    expect(parseTtsProvider('audiocpp')).toBe('audiocpp')
  })

  it('is forgiving about case and whitespace', () => {
    expect(parseTtsProvider('  AudioCPP ')).toBe('audiocpp')
  })

  // A typo must not silently pick an engine the operator did not name. It falls back to the
  // production default — the safe one — rather than throwing at config time and taking the
  // whole app down over one env var.
  it('falls back to breeze for an unknown value', () => {
    expect(parseTtsProvider('kokoro')).toBe('breeze')
    expect(parseTtsProvider('')).toBe('breeze')
  })
})

describe('speakFnFor', () => {
  it('maps each provider onto its wire adapter', () => {
    expect(speakFnFor('breeze')).toBe(breezeSpeak)
    expect(speakFnFor('audiocpp')).toBe(audiocppSpeak)
  })
})

describe('designPromptBudgetFor', () => {
  it('keeps the measured 950-char budget for the Python Breeze server', () => {
    expect(designPromptBudgetFor('breeze')).toBe(DESIGN_PROMPT_BUDGET)
  })

  it('uses the conservative audio.cpp default', () => {
    expect(designPromptBudgetFor('audiocpp')).toBe(AUDIOCPP_DESIGN_PROMPT_BUDGET)
  })

  it('lets an operator override the audio.cpp budget once it is measured higher', () => {
    expect(designPromptBudgetFor('audiocpp', 900)).toBe(900)
  })

  // The Breeze figure is a measurement of where the model breaks; an env override for the
  // OTHER engine must not move it.
  it('ignores the audio.cpp override when the provider is breeze', () => {
    expect(designPromptBudgetFor('breeze', 900)).toBe(DESIGN_PROMPT_BUDGET)
  })

  it('ignores a non-positive or non-finite override', () => {
    expect(designPromptBudgetFor('audiocpp', 0)).toBe(AUDIOCPP_DESIGN_PROMPT_BUDGET)
    expect(designPromptBudgetFor('audiocpp', Number.NaN)).toBe(AUDIOCPP_DESIGN_PROMPT_BUDGET)
  })
})
