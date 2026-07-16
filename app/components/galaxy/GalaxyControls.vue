<!-- app/components/galaxy/GalaxyControls.vue -->
<!-- Collapsible spring-control panel (spread/zoom/rotate/size/glow/link) — mirrors
     the validated prototype's `.controls` panel. `controls` is the SAME reactive
     object useGalaxy() hands the scene, so mutating a field here flows straight
     into the page's `watch(controls, …, { deep: true })` → scene.setControls(). -->
<script setup lang="ts">
import type { GalaxyControlsState } from '~/lib/galaxy/scene'

const controls = defineModel<GalaxyControlsState>({ required: true })

const isOpen = ref(true)

interface SliderDef {
  key: keyof GalaxyControlsState
  label: string
  min: number
  max: number
  step: number
  decimals: number
}

// Ranges mirror scene.ts's CLAMP table exactly.
const SLIDERS: SliderDef[] = [
  { key: 'spread', label: 'Cluster spread', min: 0.5, max: 1.9, step: 0.01, decimals: 2 },
  { key: 'zoom', label: 'Zoom', min: 0.5, max: 2.6, step: 0.01, decimals: 2 },
  { key: 'rotate', label: 'Rotate speed', min: 0, max: 4, step: 0.05, decimals: 1 },
  { key: 'size', label: 'Node size', min: 0.5, max: 2, step: 0.01, decimals: 2 },
  { key: 'glow', label: 'Glow', min: 0.0, max: 1.8, step: 0.01, decimals: 2 },
  { key: 'link', label: 'Link opacity', min: 0, max: 1.6, step: 0.01, decimals: 2 }
]

function onSlide(key: keyof GalaxyControlsState, v: number | number[]) {
  controls.value[key] = Array.isArray(v) ? (v[0] ?? controls.value[key]) : v
}
</script>

<template>
  <div class="absolute left-4 sm:left-[18px] top-16 z-[12] w-[212px] rounded-[13px] bg-[rgba(14,16,26,.72)] border border-white/[0.09] backdrop-blur-xl overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,.35)]">
    <button
      type="button"
      class="w-full flex items-center justify-between px-3.5 py-2.5 text-[11px] tracking-[0.09em] uppercase text-[#9aa0b8] select-none hover:text-[#e9eaf3] transition-colors cursor-pointer"
      :aria-expanded="isOpen"
      @click="isOpen = !isOpen"
    >
      Controls
      <UIcon
        name="i-lucide-chevron-down"
        class="size-3.5 transition-transform duration-150"
        :class="{ '-rotate-90': !isOpen }"
      />
    </button>

    <div
      v-show="isOpen"
      class="px-3.5 pb-3.5 flex flex-col gap-3"
    >
      <div
        v-for="s in SLIDERS"
        :key="s.key"
        class="flex flex-col gap-1.5"
      >
        <div class="flex justify-between text-xs text-[#cfd3e6]">
          <span>{{ s.label }}</span>
          <span class="text-[#9aa0b8] tabular-nums">{{ controls[s.key].toFixed(s.decimals) }}</span>
        </div>
        <USlider
          :model-value="controls[s.key]"
          :min="s.min"
          :max="s.max"
          :step="s.step"
          size="sm"
          :ui="{
            track: 'bg-white/10',
            range: 'bg-[#a78bfa]',
            thumb: 'bg-white ring-0 shadow-[0_0_8px_rgba(167,139,250,.8)] size-3.5'
          }"
          @update:model-value="v => onSlide(s.key, v as number | number[])"
        />
      </div>
    </div>
  </div>
</template>
