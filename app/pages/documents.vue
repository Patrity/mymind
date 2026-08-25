<script setup lang="ts">
import type { TreeNode } from '~~/server/services/tree'
import type { DocumentDTO } from '~~/shared/types/documents'
import { dirnameOf } from '~/lib/documents/folder-list'

definePageMeta({ title: 'Documents' })

const { search, useDocTree } = useDocuments()

/** Find a file's path in the tree by id — null if it isn't there (doubles as an existence check). */
function findSelectedPathInTree(nodes: TreeNode[], id: string | null): string | null {
  if (!id) return null
  for (const n of nodes) {
    if (n.type === 'file' && (n.id === id || n.path === id)) return n.path
    if (n.children) {
      const found = findSelectedPathInTree(n.children, id)
      if (found) return found
    }
  }
  return null
}

// Tree query (live-reactive via vue-query + SSE)
const { data: treeQueryData, refetch: refetchTree, isPending: treeLoading } = useDocTree()
const treeData = computed(() => treeQueryData.value ?? [])

// Selected document
const route = useRoute()
const selectedId = ref<string | null>(null)

// Last-open cookie — persists selected doc across sessions
const lastDoc = useCookie<string | null>('mm.lastDoc', { default: () => null })

// Search
const searchQuery = ref('')
const searchResults = ref<DocumentDTO[]>([])
const searchLoading = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

// New document modal
const showNewModal = ref(false)

function onSearchInput(val: string) {
  searchQuery.value = val
  if (searchTimer) clearTimeout(searchTimer)
  if (!val.trim()) {
    searchResults.value = []
    return
  }
  searchTimer = setTimeout(async () => {
    searchLoading.value = true
    try {
      searchResults.value = await search(val.trim())
    } catch {
      searchResults.value = []
    } finally {
      searchLoading.value = false
    }
  }, 300)
}

function selectSearchResult(id: string) {
  selectedId.value = id
  // Clear search
  searchQuery.value = ''
  searchResults.value = []
}

// The folder the New-document modal should preselect: the open document's folder.
const currentFolder = computed(() => {
  const path = findSelectedPathInTree(treeData.value, selectedId.value)
  return path ? dirnameOf(path) : '/'
})

// Open document from ?doc=<id> deep-link (e.g. from the command palette)
watch(
  () => route.query.doc,
  (docId) => {
    if (docId && typeof docId === 'string') {
      selectedId.value = docId
    }
  },
  { immediate: true }
)

// Persist selected doc to cookie so we can reopen it next visit
watch(selectedId, (id) => {
  if (id) lastDoc.value = id
})

// Restore last-open doc once the tree has loaded (and no ?doc= deep-link)
watch(treeData, (nodes) => {
  if (nodes.length && !route.query.doc && !selectedId.value && lastDoc.value) {
    if (findSelectedPathInTree(nodes, lastDoc.value) !== null) {
      selectedId.value = lastDoc.value
    }
  }
}, { once: true })

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<template>
  <div class="flex flex-1 min-w-0 h-full">
    <!-- Tree panel -->
    <UDashboardPanel
      id="documents-tree"
      collapsible
      resizable
      :default-size="18"
      :min-size="12"
      :max-size="35"
      class="hidden lg:flex"
      :ui="{ body: '!p-0' }"
    >
      <template #header>
        <UDashboardNavbar>
          <template #title>
            <span class="text-sm font-medium">Documents</span>
          </template>
          <template #right>
            <UButton
              icon="i-lucide-refresh-cw"
              size="xs"
              variant="ghost"
              color="neutral"
              :loading="treeLoading"
              aria-label="Refresh tree"
              @click="() => { refetchTree() }"
            />
            <UButton
              icon="i-lucide-file-plus"
              size="xs"
              variant="ghost"
              color="primary"
              aria-label="New document"
              @click="showNewModal = true"
            />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <!-- Search input -->
        <div class="px-2 pt-2 pb-1">
          <UInput
            :model-value="searchQuery"
            placeholder="Search documents…"
            icon="i-lucide-search"
            size="xs"
            class="w-full"
            @update:model-value="onSearchInput"
          />
        </div>

        <!-- Search results -->
        <div
          v-if="searchQuery && searchResults.length > 0"
          class="px-2 pb-2 flex flex-col gap-0.5"
        >
          <div class="text-xs text-muted px-1 py-0.5">
            Results
          </div>
          <button
            v-for="result in searchResults"
            :key="result.id"
            class="flex flex-col items-start px-2 py-1.5 rounded text-left hover:bg-elevated transition-colors w-full"
            @click="selectSearchResult(result.id)"
          >
            <span class="text-xs font-medium truncate w-full">{{ result.title || result.path }}</span>
            <span class="text-xs text-muted font-mono truncate w-full">{{ result.path }}</span>
          </button>
        </div>

        <div
          v-else-if="searchQuery && !searchLoading && searchResults.length === 0"
          class="px-3 py-2 text-xs text-muted"
        >
          No results
        </div>

        <!-- Tree -->
        <div
          v-if="treeLoading"
          class="space-y-2 p-2"
        >
          <USkeleton
            v-for="i in 6"
            :key="i"
            class="h-6 w-full"
          />
        </div>
        <DocumentsTree
          v-else
          :tree="treeData"
          :selected-id="selectedId"
          @select="selectedId = $event"
          @refresh="refetchTree"
        />
      </template>
    </UDashboardPanel>

    <!-- Editor panel -->
    <UDashboardPanel
      id="documents-editor"
      grow
      :ui="{ body: '!p-0' }"
    >
      <template #header>
        <UDashboardNavbar title="Documents">
          <template #leading>
            <UDashboardSidebarCollapse />
          </template>
          <template #right>
            <UButton
              icon="i-lucide-file-plus"
              size="xs"
              variant="soft"
              color="primary"
              label="New"
              class="lg:hidden"
              @click="showNewModal = true"
            />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <DocumentsEditor :document-id="selectedId" />
      </template>
    </UDashboardPanel>

    <DocumentsNewDocumentModal
      v-model:open="showNewModal"
      :tree="treeData"
      :default-folder="currentFolder"
      @created="selectedId = $event"
    />
  </div>
</template>
