<!-- app/components/voice/DesignDescription.vue -->
<script setup lang="ts">
import { instructionHint } from '~/lib/voice/studio'

const props = defineProps<{ cfgScale: number, disabled: boolean }>()
const description = defineModel<string>('description', { required: true })

// Seeds are a lottery with no ordering — measured, sweeping 3 to 999,999 showed no trend at
// all. What tightens a voice across seeds is a specific description held at cfg 4.
const hint = computed(() => instructionHint(description.value, props.cfgScale))

// ── Starter descriptions ──────────────────────────────────────────────────────
// The eight voices the rig shipped with (migration 0039). Selecting one fills the
// instruction box; it is a starting point to edit, not a locked choice.
const STARTERS = [
  { value: 'neutral-lowkey', label: 'Neutral, low-key man', description: 'A neutral, low-key man. Understated and unobtrusive, no performance, just clear.' },
  { value: 'warm-woman', label: 'Warm, thoughtful woman', description: 'A warm, thoughtful young woman with a clear voice and a calm, reflective delivery.' },
  { value: 'bright-man', label: 'Bright, energetic man', description: 'A bright, energetic young man. Quick, friendly, upbeat conversational pace.' },
  { value: 'deep-narrator', label: 'Deep narrator', description: 'A deep, calm older man with measured authority. Documentary narrator gravitas.' },
  { value: 'crisp-anchor', label: 'Crisp anchor', description: 'A crisp, precise professional woman. Newsreader clarity, neutral and articulate.' },
  { value: 'dry-laidback', label: 'Dry, laid-back man', description: 'A laid-back American man with a dry, understated delivery and subtle humour.' },
  { value: 'latenight-radio', label: 'Late-night radio', description: 'A gravelly, warm middle-aged man. Intimate late-night radio host, relaxed and smooth.' },
  { value: 'light-assistant', label: 'Light assistant', description: 'A light, upbeat woman with an approachable helpful tone. Friendly assistant energy.' }
]

// Left undefined, never '': reka-ui's USelectMenu throws on an empty-string item value,
// and an unset model is the correct "nothing chosen" state.
const starterKey = ref<string | undefined>(undefined)
watch(starterKey, (key) => {
  const starter = STARTERS.find(s => s.value === key)
  if (starter) description.value = starter.description
})
</script>

<template>
  <UFormField
    label="Start from"
    help="Fills the instruction below with one of the eight voices the rig shipped with. Edit it freely afterwards."
  >
    <USelectMenu
      v-model="starterKey"
      :items="STARTERS"
      value-key="value"
      placeholder="Pick a starting description…"
      icon="i-lucide-sparkles"
      :disabled="disabled"
      class="w-full"
    />
  </UFormField>

  <UFormField
    label="Instruction"
    help="How the voice should sound. Leave it empty for a plain or cloned voice."
  >
    <!-- The specificity nudge is an ICON, not a banner: it is guidance, and a block of
         warning-coloured text every time a description is short reads as an error the
         user has to clear. Hover mode because it is optional reading. -->
    <template #hint>
      <UPopover
        v-if="hint"
        mode="hover"
        enable-touch
      >
        <UIcon
          name="i-lucide-lightbulb"
          class="size-4 text-muted hover:text-primary cursor-help"
          aria-label="Tip about writing this description"
        />
        <template #content>
          <p class="max-w-xs p-3 text-xs text-muted">{{ hint }}</p>
        </template>
      </UPopover>
    </template>

    <UTextarea
      v-model="description"
      :rows="3"
      autoresize
      placeholder="A warm, thoughtful young woman with a calm, reflective delivery."
      :disabled="disabled"
      class="w-full"
    />
  </UFormField>
</template>
