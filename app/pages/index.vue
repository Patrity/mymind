<script setup lang="ts">
import { useQuery, keepPreviousData } from '@tanstack/vue-query'
import { HOME_RANGE_KEYS, HOME_RANGE_DEFAULT } from '~~/shared/types/home'
import type { HomeRangeKey, HomeResponse } from '~~/shared/types/home'

definePageMeta({ title: 'Home' })

// Range persists across visits, like the existing mm.documents.* prefs.
const range = useCookie<HomeRangeKey>('mm.home.range', { default: () => HOME_RANGE_DEFAULT })

const { data, isPending, error, refetch } = useQuery({
  // Reactive key — the getter alone would have stable identity and never refetch.
  queryKey: computed(() => ['home', range.value]),
  queryFn: () => $fetch<HomeResponse>('/api/home', { query: { range: range.value } }),
  // Keep the previous range's data on screen during a range switch instead of
  // dropping to the full skeleton — v5's replacement for v4's keepPreviousData: true.
  placeholderData: keepPreviousData
})
</script>

<template>
  <UDashboardPanel id="home" grow>
    <template #header>
      <UDashboardNavbar title="Home">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <!-- shrink-0 guard: the Tasks page's CTA currently clips
               20px off-screen at 390px. This must not. -->
          <UFieldGroup size="xs" class="shrink-0">
            <UButton
              v-for="k in HOME_RANGE_KEYS"
              :key="k"
              :color="range === k ? 'primary' : 'neutral'"
              :variant="range === k ? 'solid' : 'outline'"
              :label="k"
              @click="range = k"
            />
          </UFieldGroup>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- A hard initial failure (no data ever loaded) still replaces the
           page with the error card. A failed BACKGROUND refetch (vue-query
           keeps the last-good `data` populated and sets `error` alongside
           it) must never destroy an already-rendered dashboard — that only
           recovers on the next successful invalidation, and this page
           refetches on almost any app activity (9 live resources + deploy
           restarts), so a transient failure could otherwise blank the page
           for good. -->
      <div
        v-if="error && !data"
        class="p-6"
      >
        <UAlert
          color="error"
          icon="i-lucide-circle-alert"
          title="Couldn't load your dashboard"
          :description="(error as Error).message"
          :actions="[{ label: 'Retry', onClick: () => { refetch() } }]"
        />
      </div>

      <div
        v-else-if="isPending"
        class="flex flex-col gap-4 p-4 sm:p-6"
      >
        <USkeleton class="h-20 w-full" />
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <USkeleton class="h-96 lg:col-span-2" />
          <USkeleton class="h-96" />
        </div>
      </div>

      <div
        v-else-if="data"
        class="flex flex-col gap-4 p-4 sm:p-6"
      >
        <!-- Stale-but-served: a background refetch failed while the previous
             successful payload is still on screen. Non-destructive — a
             banner, not a swap — and visually distinct (subtle variant) from
             the page-level error card above. -->
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          title="Couldn't refresh your dashboard"
          description="Showing the last loaded data."
          :actions="[{ label: 'Retry', onClick: () => { refetch() } }]"
        />

        <HomeMetricsStrip
          :metrics="data.metrics"
          :usage="data.usage"
        />

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
          <div class="lg:col-span-2 min-w-0">
            <HomeTimeline
              :timeline="data.timeline"
              :range="data.range"
            />
          </div>
          <div class="flex flex-col gap-4 min-w-0">
            <HomeNeedsAttention :attention="data.attention" />
            <HomeQuickCapture />
            <HomeAskBrain />
            <HomeActiveTasks :tasks="data.tasks" />
            <HomeRecentProjects :projects="data.projects" />
          </div>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
