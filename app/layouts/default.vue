<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const { data: reviewCount, refresh: refreshCount } = await useFetch('/api/review/count', {
  key: 'review-count',
  default: () => ({ pending: 0 })
})

// Refresh count every 60 seconds
let countTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { countTimer = setInterval(refreshCount, 60_000) })
onUnmounted(() => { if (countTimer) clearInterval(countTimer) })

const mainItems = computed<NavigationMenuItem[]>(() => [
  { label: 'Capture', icon: 'i-lucide-plus', to: '/capture' },
  { label: 'Documents', icon: 'i-lucide-files', to: '/documents' },
  { label: 'Gallery', icon: 'i-lucide-image', to: '/gallery' },
  {
    label: 'Review',
    icon: 'i-lucide-inbox',
    to: '/review',
    badge: reviewCount.value.pending > 0 ? reviewCount.value.pending : undefined
  }
])
</script>

<template>
  <UDashboardGroup unit="rem">
    <UDashboardSidebar
      id="mymind-sidebar"
      collapsible
      resizable
      :default-size="14"
      :min-size="11"
      :max-size="20"
      class="bg-elevated/25"
      :ui="{ footer: 'lg:border-t lg:border-default' }"
    >
      <template #header="{ collapsed }">
        <ULink
          to="/documents"
          class="flex items-center gap-2 mx-1"
        >
          <UIcon
            name="i-lucide-brain"
            class="size-6 text-primary shrink-0"
          />
          <span
            v-if="!collapsed"
            class="text-sm font-semibold tracking-tight"
          >MyMind</span>
        </ULink>
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu
          :collapsed="collapsed"
          :items="mainItems"
          orientation="vertical"
          tooltip
        />
        <div class="mt-auto" />
      </template>

      <template #footer="{ collapsed }">
        <UColorModeButton
          v-if="!collapsed"
          size="xs"
          variant="ghost"
          color="neutral"
          class="mx-2 mb-2"
        />
      </template>
    </UDashboardSidebar>

    <slot />
  </UDashboardGroup>
</template>
