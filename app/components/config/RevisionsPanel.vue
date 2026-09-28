<script setup lang="ts">
/**
 * Revision history of a skill or job (cycle 74): newest first, actor + time. Selecting one shows
 * a read-only line diff from the revision BEFORE it to it (what that write changed) and a Revert
 * button, which restores that revision's content as a new revision. Shared by /skills/[slug]
 * and /jobs/[slug].
 */
import { useQuery } from '@tanstack/vue-query'
import { configEndpoints, type ConfigKind } from '~/lib/config/source'
import { lineDiff } from '~/lib/config/line-diff'

interface Revision { id: string, content: string, actor: string, createdAt: string }

const props = defineProps<{ kind: ConfigKind, slug: string }>()
const emit = defineEmits<{ reverted: [] }>()

const toast = useToast()
const endpoints = computed(() => configEndpoints(props.kind, props.slug))

const { data, error, isPending } = useQuery({
  // Under the kind's live-invalidated base, so a write anywhere refreshes the list.
  queryKey: computed(() => [endpoints.value.queryBase, 'revisions', props.slug]),
  queryFn: () => $fetch<Revision[]>(endpoints.value.revisions)
})
const revisions = computed(() => data.value ?? [])

const selectedId = ref<string | null>(null)
watch(() => props.slug, () => {
  selectedId.value = null
})

const selectedIndex = computed(() => revisions.value.findIndex(r => r.id === selectedId.value))
const selected = computed(() => revisions.value[selectedIndex.value] ?? null)
const diff = computed(() => {
  if (!selected.value) return []
  // Newest first, so the revision before the selected one is the NEXT entry. The oldest kept
  // revision diffs against nothing (it shows as all added).
  const prev = revisions.value[selectedIndex.value + 1]
  return lineDiff(prev?.content ?? '', selected.value.content)
})
const isLatest = computed(() => selectedIndex.value === 0)

function toggle(id: string) {
  selectedId.value = selectedId.value === id ? null : id
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const actorColor = (actor: string) => (actor === 'agent' ? 'primary' : actor === 'system' ? 'warning' : 'neutral')

const reverting = ref(false)
async function revert() {
  if (!selected.value) return
  reverting.value = true
  try {
    await $fetch(endpoints.value.revert, { method: 'POST', body: { revisionId: selected.value.id } })
    toast.add({ color: 'success', title: 'Reverted', description: `Restored the ${formatTime(selected.value.createdAt)} version` })
    selectedId.value = null
    emit('reverted')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Revert failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    reverting.value = false
  }
}

watch(error, (err) => {
  if (!err) return
  const e = err as { data?: { statusMessage?: string }, message?: string }
  toast.add({ color: 'error', title: 'Could not load revisions', description: e.data?.statusMessage ?? e.message })
})
</script>

<template>
  <div class="flex flex-col min-h-0 h-full">
    <div class="flex items-center gap-2 px-3 py-2 border-b border-default text-sm shrink-0">
      <UIcon
        name="i-lucide-history"
        class="size-4 text-dimmed"
      />
      <span class="font-medium text-highlighted">Revisions</span>
      <UBadge
        v-if="revisions.length"
        color="neutral"
        variant="subtle"
        size="sm"
      >
        {{ revisions.length }}
      </UBadge>
    </div>

    <div
      class="flex-1 min-h-0 overflow-auto"
      data-testid="revisions-list"
    >
      <div
        v-if="isPending"
        class="p-3 flex flex-col gap-2"
      >
        <USkeleton
          v-for="i in 3"
          :key="i"
          class="h-8 w-full"
        />
      </div>
      <p
        v-else-if="!revisions.length"
        class="p-3 text-sm text-muted"
      >
        No revisions yet.
      </p>

      <div
        v-for="(r, i) in revisions"
        :key="r.id"
        class="border-b border-default"
      >
        <UButton
          color="neutral"
          :variant="selectedId === r.id ? 'soft' : 'ghost'"
          block
          class="justify-start rounded-none px-3"
          :trailing-icon="selectedId === r.id ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          :data-revision-id="r.id"
          @click="toggle(r.id)"
        >
          <UBadge
            :color="actorColor(r.actor)"
            variant="subtle"
            size="sm"
          >
            {{ r.actor }}
          </UBadge>
          <span class="text-xs text-muted truncate">{{ formatTime(r.createdAt) }}</span>
          <span
            v-if="i === 0"
            class="text-xs text-dimmed"
          >current</span>
        </UButton>

        <div
          v-if="selectedId === r.id"
          class="px-3 pb-3 flex flex-col gap-2"
        >
          <pre
            class="text-xs font-mono rounded-md border border-default bg-elevated/40 max-h-80 overflow-auto py-1"
            data-testid="revision-diff"
          ><div
            v-for="(line, li) in diff"
            :key="li"
            class="px-2 whitespace-pre-wrap break-words"
            :class="{
              'bg-success/10 text-success': line.kind === 'add',
              'bg-error/10 text-error': line.kind === 'del',
              'text-muted': line.kind === 'same'
            }"
          >{{ line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  ' }}{{ line.text }}</div></pre>
          <UButton
            v-if="!isLatest"
            icon="i-lucide-undo-2"
            size="xs"
            color="neutral"
            variant="outline"
            label="Revert to this version"
            :loading="reverting"
            class="self-start"
            @click="revert"
          />
        </div>
      </div>
    </div>
  </div>
</template>
