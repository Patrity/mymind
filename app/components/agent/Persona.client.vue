<!-- app/components/agent/Persona.client.vue -->
<!-- Wraps Elements Persona (Rive). `.client.vue` so exactly one Rive canvas ever mounts per
     placement (hero / inline / full) — never SSR'd, never a hidden duplicate instance. On
     loadError (unreachable .riv, no WebGL2, …) falls back to a CSS pulsing disc so the page
     never breaks just because Vercel's asset host is unavailable. -->
<script setup lang="ts">
import type { VoiceState } from '~/composables/useVoice'
import { Persona } from '@/components/ai-elements/persona'
import { personaState, personaVariant, warnPersonaFallbackOnce } from '~/lib/agent/persona'

const props = defineProps<{
  state: VoiceState
  connected: boolean
  size?: 'hero' | 'inline' | 'full'
  /** Dev-fixture only: overrides the variant's .riv URL to force loadError. */
  srcOverride?: string
}>()

const { settings } = useVoiceSettings()

const mappedState = computed(() => personaState(props.state, props.connected))
const variant = computed(() => personaVariant(settings.value.personaVariant))

const sizeClass = computed(() => {
  switch (props.size ?? 'inline') {
    case 'hero':
      return 'size-40'
    case 'full':
      return 'size-72 sm:size-96'
    default:
      return 'size-7'
  }
})

// Active (in-motion) states get a pulsing fallback; resting states stay static — mirrors
// what the Rive state machine itself would be doing.
const pulsing = computed(() => mappedState.value === 'thinking' || mappedState.value === 'speaking' || mappedState.value === 'listening')

const failed = ref(false)
function onLoadError(err: unknown) {
  failed.value = true
  // Module-scoped latch (app/lib/agent/persona.ts) — warns once per PAGE LOAD, not once
  // per mounted instance (hero/inline/full all mount their own Persona.client.vue).
  warnPersonaFallbackOnce(err)
}
</script>

<template>
  <Persona
    v-if="!failed"
    :class="sizeClass"
    :state="mappedState"
    :variant="variant"
    :src-override="srcOverride"
    @load-error="onLoadError"
  />
  <div
    v-else
    :class="[sizeClass, 'shrink-0 rounded-full bg-primary/20', { 'animate-pulse': pulsing }]"
    role="img"
    aria-label="Bridget"
  />
</template>
