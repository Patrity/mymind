<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const mainItems: NavigationMenuItem[] = [
  { label: 'Documents', icon: 'i-lucide-files', to: '/documents' }
]
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
