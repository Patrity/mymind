<script setup lang="ts">
import type { DocumentDTO } from '~~/shared/types/documents'
import { createAutosave } from '~/lib/documents/autosave'

const props = defineProps<{
  documentId: string | null
}>()

const toast = useToast()
const { update, useDocDetail } = useDocuments()

// Live detail query — the single source of truth for this document's data (read-only; the
// vue-query convention here forbids a parallel hand-rolled fetch). `doc` below is a local
// snapshot taken from it, kept current by `metaAutosave`'s save callback below — it drives the
// summary badges.
const { data: liveDocData, isPending } = useDocDetail(() => props.documentId)
const doc = ref<DocumentDTO | null>(null)

// Metadata form fields (separate from content, which lives in Editor.vue)
const metaPath = ref('')
const metaTitle = ref('')
const metaProject = ref('')
const metaDomain = ref('')
const metaType = ref('')
const metaTags = ref('') // comma-separated
// True while the user has pending metadata edits; gates the live-sync watcher
// so an incoming SSE refresh can't overwrite a field mid-edit.
const metaDirty = ref(false)

type MetadataPatch = Pick<DocumentDTO, 'title' | 'project' | 'domain' | 'type' | 'tags'>

/** Debounced metadata save — the SAME (id, payload)-pairing module Editor.vue's content
 *  autosave uses (`~/lib/documents/autosave`), not a hand-rolled timer. This used to be its own
 *  copy of that mechanism (a `metaSaveTimer` ref plus a `saveMetadata(id = props.documentId)`
 *  default parameter) and got the document-switch case wrong: the timer stayed armed across a
 *  switch and fired later against whatever document was selected BY THEN, writing the outgoing
 *  document's title/project/domain/type/tags onto the incoming one. Owning the pair here is what
 *  makes `flush()` below safe to call from a switch or an unmount — see autosave.test.ts's
 *  "non-string payload" tests for the regression coverage. */
const metaAutosave = createAutosave<MetadataPatch>(async (id, patch) => {
  try {
    await update(id, patch)
    // Only while this save's own document is still selected — a flush from a document switch
    // must not write the outgoing metadata onto the incoming document's local state.
    if (props.documentId !== id) return
    if (doc.value) doc.value = { ...doc.value, ...patch }
    metaDirty.value = false
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Metadata save failed', description: err.data?.statusMessage ?? err.message })
  }
}, 800)

watch(liveDocData, (fresh) => {
  if (!fresh || fresh.id !== props.documentId) return
  // Sync metadata only when the user isn't mid-edit — don't clobber a pending
  // title/path/project edit inside the 800ms meta-save debounce window.
  if (metaDirty.value) return
  doc.value = fresh
  metaPath.value = fresh.path
  metaTitle.value = fresh.title ?? ''
  metaProject.value = fresh.project ?? ''
  metaDomain.value = fresh.domain ?? ''
  metaType.value = fresh.type ?? ''
  metaTags.value = (fresh.tags ?? []).join(', ')
}, { immediate: true })

watch(() => props.documentId, (id, prevId) => {
  // Flush the outgoing document's pending metadata edit before swapping. `metaAutosave` already
  // paired the edit with `prevId` at schedule time — `scheduleMetaSave` below captures both the
  // id and a snapshot of the fields synchronously, while `props.documentId` still WAS the
  // outgoing document — so unlike the old hand-rolled timer (a `metaSaveTimer` ref plus a
  // `saveMetadata(id = props.documentId)` default parameter), there is no later read of
  // `props.documentId` here for this switch to invalidate: `flush()` alone is correct, with
  // nothing to pass.
  if (prevId && metaDirty.value) {
    void metaAutosave.flush()
    // The outgoing edit has been handed off to the save above; the incoming document hasn't
    // been touched yet, so let the live watcher populate it normally instead of staying gated.
    metaDirty.value = false
  }
  if (!id) {
    doc.value = null
    metaPath.value = ''
    metaTitle.value = ''
    metaProject.value = ''
    metaDomain.value = ''
    metaType.value = ''
    metaTags.value = ''
  }
})

function currentMetaPatch(): MetadataPatch {
  return {
    title: metaTitle.value || null,
    project: metaProject.value || null,
    domain: metaDomain.value || null,
    type: metaType.value || null,
    tags: metaTags.value.split(',').map(t => t.trim()).filter(Boolean)
  }
}

// Metadata save — debounced 800ms after any meta field change, via `metaAutosave` above.
function scheduleMetaSave() {
  metaDirty.value = true
  if (props.documentId) metaAutosave.schedule(props.documentId, currentMetaPatch())
}

// Tab close / reload can't be made to wait for an in-flight save, so warn instead — mirrors
// Editor.vue's own beforeunload guard, scoped to the metadata half of the form.
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (metaDirty.value) e.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))

onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  if (metaAutosave.hasPending()) void metaAutosave.flush()
})
</script>

<template>
  <div
    v-if="!documentId"
    class="h-full flex flex-col items-center justify-center text-dimmed p-4 text-center"
  >
    <UIcon
      name="i-lucide-info"
      class="size-8 mb-3 opacity-30"
    />
    <p class="text-sm">
      Select a document to see its metadata
    </p>
  </div>

  <!-- Skeleton — shown only while the detail query has no data yet for this document
       (a fresh id, not a cached revisit); avoids flashing the previous document's
       metadata under the new document's id while the fetch is in flight. -->
  <div
    v-else-if="isPending"
    class="p-3 space-y-4"
  >
    <div class="flex items-center gap-2">
      <USkeleton class="size-3.5 rounded-full" />
      <USkeleton class="h-3 w-16" />
    </div>

    <div class="flex flex-col gap-3">
      <div
        v-for="i in 5"
        :key="i"
        class="flex flex-col gap-1.5"
      >
        <USkeleton class="h-3 w-12" />
        <USkeleton class="h-7 w-full" />
      </div>
    </div>
  </div>

  <div
    v-else
    class="p-3 space-y-4"
  >
    <div class="flex items-center gap-2 text-xs text-muted">
      <UIcon
        name="i-lucide-tag"
        class="size-3.5"
      />
      Metadata
      <div
        v-if="doc?.tags?.length || doc?.project || doc?.domain || doc?.type"
        class="flex gap-1 flex-wrap"
      >
        <UBadge
          v-if="doc.project"
          color="neutral"
          variant="outline"
          size="xs"
        >
          {{ doc.project }}
        </UBadge>
        <UBadge
          v-if="doc.domain"
          color="neutral"
          variant="outline"
          size="xs"
        >
          {{ doc.domain }}
        </UBadge>
        <UBadge
          v-for="tag in doc.tags?.slice(0, 3)"
          :key="tag"
          color="primary"
          variant="outline"
          size="xs"
        >
          {{ tag }}
        </UBadge>
      </div>
    </div>

    <div class="flex flex-col gap-3">
      <UFormField label="Title">
        <UInput
          v-model="metaTitle"
          placeholder="Document title"
          size="xs"
          class="w-full"
          @input="scheduleMetaSave"
        />
      </UFormField>

      <UFormField label="Project">
        <UInput
          v-model="metaProject"
          placeholder="project name"
          size="xs"
          class="w-full"
          @input="scheduleMetaSave"
        />
      </UFormField>

      <UFormField label="Domain">
        <UInput
          v-model="metaDomain"
          placeholder="domain"
          size="xs"
          class="w-full"
          @input="scheduleMetaSave"
        />
      </UFormField>

      <UFormField label="Type">
        <UInput
          v-model="metaType"
          placeholder="note, spec, ref…"
          size="xs"
          class="w-full"
          @input="scheduleMetaSave"
        />
      </UFormField>

      <UFormField label="Tags">
        <UInput
          v-model="metaTags"
          placeholder="tag1, tag2, tag3"
          size="xs"
          class="w-full"
          @input="scheduleMetaSave"
        />
      </UFormField>
    </div>
  </div>
</template>
