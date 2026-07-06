<!-- app/components/analytics/RequestLogTable.vue -->
<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { RequestLogRow } from '~~/shared/types/analytics'

const { useRequests } = useAnalytics()
const page = ref(1)
const { data, error, isPending } = useRequests(() => page.value)

const needsKey = computed(() => (error.value as { statusCode?: number } | null)?.statusCode === 409
  || (error.value as { data?: { statusCode?: number } } | null)?.data?.statusCode === 409)

const columns: TableColumn<RequestLogRow>[] = [
  { accessorKey: 'startedAt', header: 'Time', cell: ({ row }) => row.original.startedAt ? new Date(row.original.startedAt).toLocaleString() : '—' },
  { accessorKey: 'model', header: 'Model' },
  { accessorKey: 'promptTokens', header: 'In' },
  { accessorKey: 'completionTokens', header: 'Out' },
  { accessorKey: 'latencyMs', header: 'Latency', cell: ({ row }) => row.original.latencyMs == null ? '—' : `${row.original.latencyMs} ms` },
  { accessorKey: 'spendUsd', header: 'Cost', cell: ({ row }) => row.original.spendUsd == null ? '—' : `$${row.original.spendUsd.toFixed(5)}` },
  { accessorKey: 'keyAlias', header: 'Key' },
  { accessorKey: 'status', header: 'Status' },
]
const rows = computed<RequestLogRow[]>(() => data.value?.rows ?? [])
</script>

<template>
  <UCard :ui="{ body: 'p-0' }">
    <template #header>
      <span class="text-sm font-medium text-highlighted">Recent LiteLLM requests</span>
    </template>
    <UAlert v-if="needsKey" color="info" variant="subtle" class="m-4" title="LiteLLM key not configured"
            description="Add the master key to enable the request log.">
      <template #actions>
        <UButton size="xs" variant="subtle" to="/settings/analytics">Open Settings → Analytics</UButton>
      </template>
    </UAlert>
    <UAlert v-else-if="error" color="error" variant="subtle" class="m-4" title="LiteLLM unreachable" />
    <template v-else>
      <UTable :data="rows" :columns="columns" :loading="isPending" />
      <div class="flex items-center justify-end gap-2 border-t border-default p-2">
        <UButton size="xs" variant="ghost" icon="i-lucide-chevron-left" :disabled="page <= 1" @click="page--" />
        <span class="text-xs text-muted">page {{ page }}<template v-if="data?.totalPages"> / {{ data.totalPages }}</template></span>
        <UButton size="xs" variant="ghost" icon="i-lucide-chevron-right" :disabled="!!data?.totalPages && page >= data.totalPages" @click="page++" />
      </div>
    </template>
  </UCard>
</template>
