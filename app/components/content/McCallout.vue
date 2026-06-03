<script setup lang="ts">
const props = withDefaults(defineProps<{
  type?: 'info' | 'warning' | 'success' | 'error'
}>(), {
  type: 'info'
})

const iconMap: Record<string, string> = {
  info: 'i-lucide-info',
  warning: 'i-lucide-triangle-alert',
  success: 'i-lucide-check-circle',
  error: 'i-lucide-x-circle'
}

const colorMap: Record<string, 'info' | 'warning' | 'success' | 'error'> = {
  info: 'info',
  warning: 'warning',
  success: 'success',
  error: 'error'
}

const icon = computed(() => iconMap[props.type] ?? iconMap.info)
const color = computed(() => colorMap[props.type] ?? 'info')
</script>

<template>
  <div
    class="my-3 flex gap-3 rounded-lg border px-4 py-3 text-sm"
    :class="{
      'border-info/30 bg-info/5 text-info': type === 'info',
      'border-warning/30 bg-warning/5 text-warning': type === 'warning',
      'border-success/30 bg-success/5 text-success': type === 'success',
      'border-error/30 bg-error/5 text-error': type === 'error'
    }"
  >
    <UIcon
      :name="icon"
      class="mt-0.5 size-4 shrink-0"
    />
    <div class="min-w-0 flex-1 leading-relaxed">
      <slot />
    </div>
  </div>
</template>
