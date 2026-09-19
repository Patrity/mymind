import type { VoiceState } from '~/composables/useVoice'

export const PERSONA_VARIANTS = ['obsidian', 'mana', 'opal', 'halo', 'glint', 'command'] as const
export type PersonaVariant = typeof PERSONA_VARIANTS[number]

export type PersonaState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'asleep'

/**
 * Map voice states and connection status onto the five Persona visual states.
 * - When disconnected, Persona sleeps (asleep)
 * - States like 'thinking', 'tool', 'typing' all show as 'thinking'
 * - 'connecting' is treated as asleep (no Persona animation during reconnect)
 */
export function personaState(state: VoiceState, connected: boolean): PersonaState {
  if (!connected) return 'asleep'
  switch (state) {
    case 'idle':
      return 'idle'
    case 'listening':
      return 'listening'
    case 'thinking':
    case 'tool':
    case 'typing':
      return 'thinking'
    case 'speaking':
      return 'speaking'
    case 'connecting':
      return 'asleep'
  }
}

/**
 * Normalize unknown values to the default persona variant.
 * Known variants pass through; anything else defaults to 'obsidian'.
 */
export function personaVariant(v: unknown): PersonaVariant {
  if (typeof v === 'string' && PERSONA_VARIANTS.includes(v as PersonaVariant)) {
    return v as PersonaVariant
  }
  return 'obsidian'
}
