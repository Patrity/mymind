<script setup lang="ts">
/**
 * Cycle 82 Task 3 (spec §7): a workspace's background shells — running and recent, the selected
 * one's output tail (read inside the sandbox by the agent worker; never moves Bridget's bash_output
 * offset) and Kill (session-only; stops its whole process group). Output is untrusted text: shown
 * escaped, never rendered.
 */
import type { WorkspaceShellDTO } from '@mymind/core/shared/types/workspaces'

const props = defineProps<{ workspaceId: string }>()
const toast = useToast()

const { data: shells, error } = useWorkspaceShells(() => props.workspaceId)
const list = computed(() => shells.value ?? [])
const selectedId = ref<string | null>(null)
watch(list, (l) => {
  if (!l.length) { selectedId.value = null; return }
  if (!selectedId.value || !l.some(s => s.id === selectedId.value)) selectedId.value = (l.find(s => s.state === 'running') ?? l[0]!).id
}, { immediate: true })
const selected = computed(() => list.value.find(s => s.id === selectedId.value) ?? null)
const { data: tail, error: tailError } = useShellTail(() => props.workspaceId, selectedId, () => selected.value?.state === 'running')

const STATE: Record<WorkspaceShellDTO['state'], { color: 'success' | 'neutral' | 'warning' | 'error'; label: string }> = {
  running: { color: 'success', label: 'running' },
  exited: { color: 'neutral', label: 'exited' },
  killed: { color: 'warning', label: 'killed' },
  lost: { color: 'error', label: 'lost' }
}
const stateOf = (s: WorkspaceShellDTO) => STATE[s.state]
const when = (iso: string) => new Date(iso).toLocaleString()

const { kill } = useWorkspaceActions()
async function stop(s: WorkspaceShellDTO) {
  try {
    const r = await kill.mutateAsync({ workspaceId: props.workspaceId, shellId: s.id })
    toast.add({ title: r.alreadyEnded ? `Already ${r.state}` : 'Shell stopped', color: 'success' })
  } catch (e) {
    toast.add({ color: 'error', title: 'Could not stop the shell', description: workspaceErrorOf(e) })
  }
}
</script>

<template>
  <div
    class="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(240px,1fr)_2fr]"
    data-testid="workspace-shells"
  >
    <div class="max-h-[40vh] min-h-0 overflow-y-auto border-b border-default p-2 md:max-h-none md:border-r md:border-b-0">
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        title="Could not load the shells"
        :description="workspaceErrorOf(error)"
      />
      <p
        v-else-if="shells && !list.length"
        class="p-2 text-sm text-muted"
      >
        No background shells yet. Bridget starts one with <code>bash</code> + <code>run_in_background</code>.
      </p>
      <div class="flex flex-col gap-1">
        <UButton
          v-for="s in list"
          :key="s.id"
          :variant="s.id === selectedId ? 'soft' : 'ghost'"
          color="neutral"
          class="w-full justify-start"
          :data-testid="`shell-row-${s.id}`"
          @click="selectedId = s.id"
        >
          <span class="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
            <code class="w-full truncate text-xs text-highlighted">{{ s.command }}</code>
            <span class="text-xs text-dimmed">{{ when(s.startedAt) }}</span>
          </span>
          <UBadge
            :color="stateOf(s).color"
            variant="subtle"
            size="sm"
            :label="s.exitCode !== null ? `${stateOf(s).label} ${s.exitCode}` : stateOf(s).label"
          />
        </UButton>
      </div>
    </div>

    <div class="flex min-h-0 flex-col">
      <template v-if="selected">
        <div class="flex items-center gap-2 border-b border-default px-3 py-2">
          <code class="truncate text-xs text-highlighted">{{ selected.command }}</code>
          <UButton
            v-if="selected.state === 'running'"
            class="ml-auto shrink-0"
            color="error"
            variant="soft"
            size="xs"
            icon="i-lucide-square"
            label="Kill"
            :loading="kill.isPending.value"
            data-testid="shell-kill"
            @click="stop(selected)"
          />
        </div>
        <p
          v-if="selected.reason"
          class="border-b border-default px-3 py-2 text-xs text-muted"
        >
          {{ selected.reason }}
        </p>
        <div class="min-h-0 flex-1 overflow-auto p-3">
          <UAlert
            v-if="tailError"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            title="Could not read its output"
            :description="workspaceErrorOf(tailError)"
          />
          <template v-else-if="tail">
            <p
              v-if="tail.truncated"
              class="mb-2 text-xs text-muted"
            >
              Last 16 KB of {{ tail.outputBytes }} bytes.
            </p>
            <pre
              class="text-xs whitespace-pre-wrap break-words text-default"
              data-testid="shell-output"
            >{{ tail.output || '(no output yet)' }}</pre>
          </template>
        </div>
      </template>
      <p
        v-else
        class="p-3 text-sm text-muted"
      >
        Pick a shell to see its output.
      </p>
    </div>
  </div>
</template>
