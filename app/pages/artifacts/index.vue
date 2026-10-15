<script setup lang="ts">
/**
 * /artifacts (cycle 86) — webapps and pages Bridget published. Live via the `artifact` resource.
 * Always pass the artifact UUID to the mutations (never the slug) so live invalidation keys match.
 */
import type { TableColumn } from '@nuxt/ui'
import type { ArtifactDTO } from '@mymind/core/shared/types/artifacts'
import { formatBytes } from '~/lib/artifacts/display'

definePageMeta({ title: 'Artifacts' })

const toast = useToast()
const { data, error, isPending } = useArtifactList()
const rows = computed<ArtifactDTO[]>(() => data.value ?? [])

function messageOf(e: unknown): string {
  const x = e as { data?: { message?: string, statusMessage?: string }, message?: string }
  return x.data?.message ?? x.data?.statusMessage ?? x.message ?? 'Unknown error'
}

watch(error, (err) => {
  if (err) toast.add({ color: 'error', title: 'Could not load artifacts', description: messageOf(err) })
})

const columns: TableColumn<ArtifactDTO>[] = [
  { accessorKey: 'title', header: 'Title' },
  { accessorKey: 'slug', header: 'Slug' },
  { id: 'visibility', header: 'Public' },
  { accessorKey: 'versionCount', header: 'Versions' },
  { id: 'size', header: 'Size' },
  { id: 'updated', header: 'Updated' },
  { id: 'actions', header: '' }
]

const pending = ref<Record<string, boolean>>({})
async function setPublic(a: ArtifactDTO, isPublic: boolean) {
  pending.value = { ...pending.value, [a.id]: true }
  try {
    await updateArtifact(a.id, { isPublic })
  } catch (e) {
    toast.add({ color: 'error', title: 'Could not change visibility', description: messageOf(e) })
  } finally {
    pending.value = { ...pending.value, [a.id]: false }
  }
}

async function copyLink(a: ArtifactDTO) {
  try {
    await navigator.clipboard.writeText(new URL(a.url, window.location.origin).toString())
    toast.add({ color: 'success', title: 'Link copied' })
  } catch {
    toast.add({ color: 'error', title: 'Could not copy the link' })
  }
}

const confirmTarget = ref<ArtifactDTO | null>(null)
const confirmOpen = computed({
  get: () => !!confirmTarget.value,
  set: (v) => { if (!v) confirmTarget.value = null }
})
const deleting = ref(false)
async function confirmDelete() {
  const a = confirmTarget.value
  if (!a) return
  deleting.value = true
  try {
    await removeArtifact(a.id)
    toast.add({ color: 'success', title: 'Artifact deleted', description: a.title })
    confirmTarget.value = null
  } catch (e) {
    toast.add({ color: 'error', title: 'Could not delete', description: messageOf(e) })
  } finally {
    deleting.value = false
  }
}

function menuItems(a: ArtifactDTO) {
  return [[
    { label: 'Open', icon: 'i-lucide-external-link', to: a.url, target: '_blank', external: true },
    { label: 'Copy link', icon: 'i-lucide-link', onSelect: () => copyLink(a) }
  ], [
    { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => { confirmTarget.value = a } }
  ]]
}
</script>

<template>
  <UDashboardPanel
    id="artifacts-panel"
    grow
  >
    <template #header>
      <UDashboardNavbar title="Artifacts">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p
        v-if="!isPending && !rows.length"
        class="text-sm text-muted"
        data-testid="artifacts-empty"
      >
        No artifacts yet — ask Bridget to build something visual.
      </p>

      <UTable
        v-else
        :data="rows"
        :columns="columns"
        :loading="isPending"
        :get-row-id="(r: ArtifactDTO) => r.id"
        data-testid="artifacts-table"
      >
        <template #title-cell="{ row }">
          <ULink
            :to="`/artifacts/${row.original.id}`"
            class="font-medium text-highlighted"
            :data-artifact="row.original.id"
          >
            {{ row.original.title }}
          </ULink>
        </template>
        <template #slug-cell="{ row }">
          <span class="font-mono text-xs text-muted">{{ row.original.slug }}</span>
        </template>
        <template #visibility-cell="{ row }">
          <USwitch
            :model-value="row.original.isPublic"
            :disabled="pending[row.original.id]"
            :aria-label="`Make ${row.original.title} ${row.original.isPublic ? 'private' : 'public'}`"
            :data-testid="`artifact-public-${row.original.id}`"
            @update:model-value="(v: boolean) => setPublic(row.original, v)"
          />
        </template>
        <template #size-cell="{ row }">
          <span class="tabular-nums">{{ formatBytes(row.original.totalBytes) }}</span>
        </template>
        <template #updated-cell="{ row }">
          <span class="text-xs text-muted">{{ new Date(row.original.updatedAt).toLocaleString() }}</span>
        </template>
        <template #actions-cell="{ row }">
          <UDropdownMenu :items="menuItems(row.original)">
            <UButton
              icon="i-lucide-ellipsis"
              color="neutral"
              variant="ghost"
              size="xs"
              aria-label="Artifact actions"
              :data-testid="`artifact-menu-${row.original.id}`"
            />
          </UDropdownMenu>
        </template>
      </UTable>

      <UModal
        v-model:open="confirmOpen"
        title="Delete artifact?"
        :description="confirmTarget ? `“${confirmTarget.title}” and its link /artifact/${confirmTarget.slug}/ stop working.` : ''"
      >
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              label="Cancel"
              @click="confirmTarget = null"
            />
            <UButton
              color="error"
              label="Delete"
              :loading="deleting"
              data-testid="artifact-confirm-delete"
              @click="confirmDelete"
            />
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
