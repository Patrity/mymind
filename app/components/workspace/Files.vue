<script setup lang="ts">
/**
 * Cycle 82 Task 3 (spec §7): a workspace's files — the tree (sizes, ≤ 500 entries), a viewer and
 * download. Everything is read INSIDE the sandbox by the agent worker; nothing here touches a host
 * path. Workspace content is untrusted (model- or internet-written): markdown and code render only
 * through the hardened MessageResponse (agentMarkdownProps: no raw HTML, previewers off), anything
 * else as escaped text.
 */
import type { TreeItem } from '@nuxt/ui'
import { MessageResponse } from '@/components/ai-elements/message'
import { buildTree, fenced, formatBytes, viewKind, type FileNode } from '~/lib/workspace/display'

const props = defineProps<{ workspaceId: string }>()

/** Above this, markdown/code is shown as plain text (rendering a megabyte through shiki stalls the tab). */
const RENDER_MAX = 200_000

const { data: tree, error: treeError, isFetching: treeLoading, refetch } = useWorkspaceTree(() => props.workspaceId)
const selected = ref<string | null>(null)
watch(() => props.workspaceId, () => { selected.value = null })
const { data: file, error: fileError, isFetching: fileLoading } = useWorkspaceFile(() => props.workspaceId, selected)

type Item = TreeItem & { node: FileNode }
function toItems(nodes: FileNode[]): Item[] {
  return nodes.map(n => ({
    label: n.label,
    node: n,
    icon: n.type === 'dir' ? 'i-lucide-folder' : n.type === 'link' ? 'i-lucide-link' : 'i-lucide-file',
    ...(n.children?.length ? { children: toItems(n.children) } : {}),
    disabled: n.type === 'link' || !!n.skipped,
    onSelect: () => { if (n.type === 'file') selected.value = n.path }
  }))
}
const items = computed(() => toItems(buildTree(tree.value?.entries ?? [])))

const kind = computed(() => (selected.value ? viewKind(selected.value) : { kind: 'text' as const }))
const rendered = computed(() => {
  const f = file.value
  if (!f || f.binary || f.content === undefined || f.content.length > RENDER_MAX) return null
  if (kind.value.kind === 'markdown') return f.content
  if (kind.value.kind === 'code') return fenced(f.content, kind.value.lang)
  return null
})
const downloadHref = computed(() => selected.value ? `/api/workspaces/${props.workspaceId}/download?path=${encodeURIComponent(selected.value)}` : undefined)
</script>

<template>
  <div
    class="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(220px,1fr)_2fr]"
    data-testid="workspace-files"
  >
    <div class="flex min-h-0 flex-col border-b border-default md:border-r md:border-b-0">
      <div class="flex items-center gap-2 border-b border-default px-3 py-2">
        <span class="text-xs text-muted">
          {{ tree ? `${tree.count} entr${tree.count === 1 ? 'y' : 'ies'}` : 'Files' }}
        </span>
        <UBadge
          v-if="tree?.truncated"
          color="warning"
          variant="subtle"
          size="sm"
          label="first 500 shown"
        />
        <UButton
          class="ml-auto"
          icon="i-lucide-refresh-cw"
          size="xs"
          variant="ghost"
          color="neutral"
          aria-label="Refresh files"
          :loading="treeLoading"
          @click="refetch()"
        />
      </div>
      <div class="max-h-[40vh] min-h-0 flex-1 overflow-y-auto p-2 md:max-h-none">
        <UAlert
          v-if="treeError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          title="Could not list the files"
          :description="workspaceErrorOf(treeError)"
        />
        <p
          v-else-if="tree && !tree.entries.length"
          class="p-2 text-sm text-muted"
        >
          The workspace is empty.
        </p>
        <UTree
          v-else
          :items="items"
          :get-key="(i: Item) => i.node.path"
          size="sm"
          data-testid="workspace-tree"
        >
          <template #item-trailing="{ item, expanded }">
            <span class="flex items-center gap-1 text-xs text-dimmed tabular-nums">
              <span v-if="(item as Item).node.skipped">not listed</span>
              <span v-else-if="(item as Item).node.type === 'link'">→ {{ (item as Item).node.target }}</span>
              <span v-else>{{ formatBytes((item as Item).node.bytes) }}</span>
              <UIcon
                v-if="(item as Item).children?.length"
                name="i-lucide-chevron-down"
                class="size-4 transition-transform"
                :class="expanded ? '' : '-rotate-90'"
              />
            </span>
          </template>
        </UTree>
      </div>
    </div>

    <div
      class="flex min-h-0 flex-col"
      data-testid="workspace-viewer"
    >
      <div
        v-if="selected"
        class="flex items-center gap-2 border-b border-default px-3 py-2"
      >
        <code class="truncate text-xs text-highlighted">{{ selected }}</code>
        <span
          v-if="file"
          class="shrink-0 text-xs text-muted"
        >{{ formatBytes(file.bytes) }}<template v-if="file.lines !== undefined"> · {{ file.lines }} lines</template></span>
        <UButton
          class="ml-auto shrink-0"
          icon="i-lucide-download"
          size="xs"
          variant="soft"
          color="neutral"
          label="Download"
          :to="downloadHref"
          external
          download
          data-testid="workspace-download"
        />
      </div>
      <div class="min-h-0 flex-1 overflow-auto p-3">
        <p
          v-if="!selected"
          class="text-sm text-muted"
        >
          Pick a file to view it.
        </p>
        <UAlert
          v-else-if="fileError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          title="Could not open the file"
          :description="workspaceErrorOf(fileError)"
        />
        <div
          v-else-if="fileLoading && !file"
          class="text-sm text-muted"
        >
          Loading…
        </div>
        <template v-else-if="file">
          <UAlert
            v-if="file.truncated"
            color="warning"
            variant="subtle"
            icon="i-lucide-scissors"
            title="Truncated"
            :description="`Showing the first ${file.lines} lines (the view stops at 2000 lines / 1 MB). Download it for the whole file.`"
            class="mb-3"
            data-testid="workspace-truncated"
          />
          <p
            v-if="file.binary"
            class="text-sm text-muted"
          >
            Binary file ({{ formatBytes(file.bytes) }}) — not shown. Download it instead.
          </p>
          <MessageResponse
            v-else-if="rendered !== null"
            :key="`${workspaceId}:${selected}:${file.bytes}`"
            :content="rendered"
            class="text-sm"
            data-testid="workspace-rendered"
          />
          <pre
            v-else
            class="text-xs whitespace-pre-wrap break-words text-default"
            data-testid="workspace-plain"
          >{{ file.content }}</pre>
        </template>
      </div>
    </div>
  </div>
</template>
