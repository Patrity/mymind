import type { VoiceState } from '~/composables/useVoice'

// 'halo' and 'command' are deliberately excluded: both artboards render only WHITE artwork —
// no dynamicColor theme adaptation, unlike obsidian's — so they're invisible (white-on-white)
// in light mode and only show up in dark mode (verified via the /dev/elements fixture: halo
// = a bright ring, command = a white slash, both cycled through every state; obsidian/mana/
// opal/glint all render in both themes). Offering a picker option that goes blank depending on
// the viewer's OS theme is worse than not offering it. The vendored `ai-elements/persona`
// wrapper's own `sources` map (Persona.vue) still lists all six — this only trims what OUR
// picker/normalizer treat as valid.
export const PERSONA_VARIANTS = ['obsidian', 'mana', 'opal', 'glint'] as const
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
 * Known (offered) variants pass through; anything else — including a cookie that still
 * carries 'halo' or 'command' from before they were dropped from PERSONA_VARIANTS above —
 * defaults to 'obsidian'.
 */
export function personaVariant(v: unknown): PersonaVariant {
  if (typeof v === 'string' && PERSONA_VARIANTS.includes(v as PersonaVariant)) {
    return v as PersonaVariant
  }
  return 'obsidian'
}

// Module-scope (not per-component-instance) so a down Rive host warns exactly once per page
// load, no matter how many AgentPersona instances mount (hero/inline/full transitions, the
// dev fixture's several rows, …) — a `let` inside a component's <script setup> resets per
// instance and would warn once per mount instead.
let personaFallbackWarned = false

/** Reset for tests only — production never needs to un-latch this within a page load. */
export function resetPersonaFallbackWarning(): void {
  personaFallbackWarned = false
}

export function warnPersonaFallbackOnce(err: unknown): void {
  if (personaFallbackWarned) return
  personaFallbackWarned = true
  // eslint-disable-next-line no-console
  console.warn('[persona] falling back:', err)
}
