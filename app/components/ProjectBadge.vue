<script setup lang="ts">
import { computed } from 'vue'
import { projectColor } from '~/utils/project-color'
const props = defineProps<{ slug: string, name?: string | null, color?: string | null, to?: string | false }>()
const { map } = useProjects().useProjectColors()
// explicit color prop wins; else the shared override map; else the deterministic default
const c = computed(() => projectColor(props.slug, props.color ?? map.value.get(props.slug) ?? null))
const label = computed(() => props.name || props.slug)
// Compute resolved link: false → no link (span); string → explicit override; undefined → project dashboard
const resolvedTo = computed(() => {
  if (props.to === false) return undefined
  return props.to ?? ('/projects/' + encodeURIComponent(props.slug))
})
</script>
<template>
  <component
    :is="to === false ? 'span' : 'NuxtLink'"
    :to="resolvedTo"
    class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium border max-w-full align-middle"
    :style="{ color: c, backgroundColor: c + '1f', borderColor: c + '40' }"
    :title="label"
  >
    <span class="size-1.5 rounded-full shrink-0" :style="{ backgroundColor: c }" />
    <span class="truncate">{{ label }}</span>
  </component>
</template>
