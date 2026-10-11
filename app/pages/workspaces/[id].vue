<script setup lang="ts">
/**
 * /workspaces/[id] (cycle 82 Task 3): one workspace — `home` is the chat's (the agent header's
 * "Workspace" link). The same Files / Shells views as a workstream's detail page, plus the tainted
 * banner. Reads go through the agent worker (it owns the sandbox).
 */
import { formatBytes } from '~/lib/workspace/display'

definePageMeta({ title: 'Workspace' })

const route = useRoute()
const toast = useToast()
const param = computed(() => String(route.params.id ?? ''))
// `home` resolves to the real row; every later read (and the live key) uses its uuid.
const { data: resolved, error } = useWorkspace(param)
watch(error, (e) => { if (e) toast.add({ color: 'error', title: 'Could not load the workspace', description: workspaceErrorOf(e) }) })
const wsId = computed(() => resolved.value?.id ?? null)
const { data: live } = useWorkspace(() => (param.value === 'home' ? wsId.value : null))
const ws = computed(() => live.value ?? resolved.value ?? null)

const tab = ref('files')
const tabs = [
  { label: 'Files', value: 'files', icon: 'i-lucide-folder' },
  { label: 'Shells', value: 'shells', icon: 'i-lucide-terminal' }
]
</script>

<template>
  <UDashboardPanel
    id="workspace-panel"
    grow
    :ui="{ body: '!p-0 !gap-0' }"
  >
    <template #header>
      <UDashboardNavbar :title="ws?.kind === 'home' ? 'Workspace — chat' : 'Workspace'">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UButton
            icon="i-lucide-arrow-left"
            variant="ghost"
            color="neutral"
            :aria-label="ws?.workstreamId ? 'Back to the workstream' : 'Back to the chat'"
            :to="ws?.workstreamId ? `/workstreams/${ws.workstreamId}` : '/agent'"
          />
        </template>
        <template #right>
          <span
            v-if="ws"
            class="text-xs text-muted"
            data-testid="workspace-usage"
          >{{ formatBytes(ws.bytesUsed) }} · {{ ws.state }}</span>
        </template>
      </UDashboardNavbar>
      <AgentWorkerOfflineBanner />
    </template>

    <template #body>
      <WorkspaceNetworkBanner
        v-if="ws"
        :workspace="ws"
      />
      <UTabs
        v-model="tab"
        :items="tabs"
        :content="false"
        variant="link"
        class="shrink-0 px-3"
        data-testid="workspace-tabs"
      />
      <template v-if="wsId">
        <WorkspaceFiles
          v-if="tab === 'files'"
          :workspace-id="wsId"
        />
        <WorkspaceShells
          v-else
          :workspace-id="wsId"
        />
      </template>
    </template>
  </UDashboardPanel>
</template>
