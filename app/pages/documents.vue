<script setup lang="ts">
import type { TreeNode } from '~~/server/services/tree'
import type { DocumentDTO } from '~~/shared/types/documents'

definePageMeta({ title: 'Documents' })

const { tree, create, search } = useDocuments()
const toast = useToast()

/** Check if a doc id exists anywhere in the loaded tree */
function docExistsInTree(nodes: TreeNode[], id: string): boolean {
  for (const n of nodes) {
    if (n.type === 'file' && (n.id === id || n.path === id)) return true
    if (n.children && docExistsInTree(n.children, id)) return true
  }
  return false
}

// Tree state
const treeData = ref<TreeNode[]>([])
const treeLoading = ref(false)

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
const newPath = ref('/input/untitled.md')
const creating = ref(false)

async function loadTree() {
  treeLoading.value = true
  try {
    treeData.value = await tree()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to load tree', description: err.data?.statusMessage ?? err.message })
  } finally {
    treeLoading.value = false
  }
}

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

async function createDocument() {
  if (!newPath.value.trim()) return
  creating.value = true
  try {
    const doc = await create({ path: newPath.value.trim() })
    await loadTree()
    selectedId.value = doc.id
    showNewModal.value = false
    newPath.value = '/input/untitled.md'
    toast.add({ color: 'success', title: 'Document created', description: doc.path })
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Create failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    creating.value = false
  }
}

function openNewModal() {
  newPath.value = '/input/untitled.md'
  showNewModal.value = true
}

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

onMounted(async () => {
  await loadTree()

  // Restore last-open doc if no ?doc= query param and no selection yet
  if (!route.query.doc && !selectedId.value && lastDoc.value) {
    // Verify the doc still exists in the tree before selecting
    const exists = docExistsInTree(treeData.value, lastDoc.value)
    if (exists) {
      selectedId.value = lastDoc.value
    }
  }
})

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
              @click="loadTree"
            />
            <UButton
              icon="i-lucide-file-plus"
              size="xs"
              variant="ghost"
              color="primary"
              aria-label="New document"
              @click="openNewModal"
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
          @refresh="loadTree"
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
              @click="openNewModal"
            />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <DocumentsEditor :document-id="selectedId" />
      </template>
    </UDashboardPanel>

    <!-- New document modal -->
    <UModal v-model:open="showNewModal">
      <template #content>
        <UCard>
          <template #header>
            <div class="flex items-center gap-2">
              <UIcon
                name="i-lucide-file-plus"
                class="size-5"
              />
              <span class="font-semibold">New document</span>
            </div>
          </template>

          <UFormField
            label="Path"
            description="e.g. /input/my-note.md"
          >
            <UInput
              v-model="newPath"
              placeholder="/input/untitled.md"
              autofocus
              class="w-full font-mono text-sm"
              @keyup.enter="createDocument"
            />
          </UFormField>

          <template #footer>
            <div class="flex justify-end gap-2">
              <UButton
                color="neutral"
                variant="ghost"
                @click="showNewModal = false"
              >
                Cancel
              </UButton>
              <UButton
                :loading="creating"
                :disabled="!newPath.trim()"
                @click="createDocument"
              >
                Create
              </UButton>
            </div>
          </template>
        </UCard>
      </template>
    </UModal>
  </div>
</template>
