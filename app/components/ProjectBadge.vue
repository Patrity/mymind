<script setup lang="ts">
import { computed } from 'vue'
import { projectColor } from '~/utils/project-color'
// `to` is intentionally `string | null` (NOT `string | false`): a Boolean in the
// prop type makes Vue treat `to` as a boolean prop and cast an ABSENT `to` to
// `false`, which is indistinguishable from an explicit no-link. With `null` for
// "no link", an absent `to` stays `undefined` and correctly defaults to the
// project dashboard link.
const props = defineProps<{ slug: string, name?: string | null, color?: string | null, to?: string | null }>()
const { map } = useProjects().useProjectColors()
// explicit color prop wins; else the shared override map; else the deterministic default
const c = computed(() => projectColor(props.slug, props.color ?? map.value.get(props.slug) ?? null))
const label = computed(() => props.name || props.slug)
// Resolve the real NuxtLink component object — `<component :is="'NuxtLink'">`
// (a string) renders an inert <nuxtlink> custom element instead of an <a>.
const NuxtLink = resolveComponent('NuxtLink')
// Resolve link: null → no link (span); string → explicit override; undefined → project dashboard
const isLink = computed(() => props.to !== null)
const resolvedTo = computed(() =>
  props.to === null ? undefined : (props.to ?? ('/projects/' + encodeURIComponent(props.slug)))
)
</script>
<template>
  <component
    :is="isLink ? NuxtLink : 'span'"
    :to="resolvedTo"
    class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium border max-w-full align-middle"
    :style="{ color: c, backgroundColor: c + '1f', borderColor: c + '40' }"
    :title="label"
  >
    <span class="size-1.5 rounded-full shrink-0" :style="{ backgroundColor: c }" />
    <span class="truncate">{{ label }}</span>
  </component>
</template>
