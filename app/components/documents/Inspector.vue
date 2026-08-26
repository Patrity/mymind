<script setup lang="ts">
import type { DocumentDTO } from '~~/shared/types/documents'

const props = defineProps<{
  documentId: string | null
}>()

const toast = useToast()
const { update, useDocDetail } = useDocuments()

// Live detail query — the single source of truth for this document's data (read-only; the
// vue-query convention here forbids a parallel hand-rolled fetch). `doc` below is a local
// snapshot taken from it: it drives the summary badges and lets saveMetadata() know a document
// has actually loaded before it writes anything.
const { data: liveDocData, isPending } = useDocDetail(() => props.documentId)
const doc = ref<DocumentDTO | null>(null)

// Metadata form fields (separate from content, which lives in Editor.vue)
const metaPath = ref('')
const metaTitle = ref('')
const metaProject = ref('')
const metaDomain = ref('')
const metaType = ref('')
// Tags are edited as real chips (UInputTags), so this mirrors the stored shape directly
// rather than round-tripping through a comma-joined string.
const metaTags = ref<string[]>([])
const metaSaveTimer: Ref<ReturnType<typeof setTimeout> | null> = ref(null)
// True while the user has pending metadata edits; gates the live-sync watcher
// so an incoming SSE refresh can't overwrite a field mid-edit.
const metaDirty = ref(false)

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
  metaTags.value = [...(fresh.tags ?? [])]
}, { immediate: true })

watch(() => props.documentId, (id, prevId) => {
  // Write the outgoing document's pending metadata edit before swapping — see saveMetadata's
  // comment below for why `prevId` (not the prop) is passed explicitly. Every meta*.value read
  // it makes is synchronous, so this capture happens before the watcher above (driven by
  // useDocDetail's query resolving for the new id) ever repopulates the draft.
  if (prevId && metaDirty.value) {
    // Cancel the pending debounce timer too. Without this, the ORIGINAL 800ms timer is still
    // armed and fires later — after props.documentId has become the incoming document — calling
    // saveMetadata() with no argument, whose default `id = props.documentId` now resolves to the
    // INCOMING document while these fields still hold the OUTGOING one's stale text. That
    // silently overwrites the incoming document's metadata. (autosave.ts's flush()/take() clears
    // its timer the same way, for the identical reason, on the content side.)
    if (metaSaveTimer.value) {
      clearTimeout(metaSaveTimer.value)
      metaSaveTimer.value = null
    }
    void saveMetadata(prevId)
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
    metaTags.value = []
  }
})

// Metadata save — debounced 800ms after any meta field change.
// `id` is explicit for the same reason the content save takes one: on a document switch this
// runs while props.documentId already points at the INCOMING document, so reading it here
// would write the outgoing document's title/project onto the new one. Every meta*.value read
// below is synchronous, so calling this before the incoming document loads captures the right
// values.
async function saveMetadata(id = props.documentId) {
  if (!id || !doc.value) return
  const tags = metaTags.value.map(t => t.trim()).filter(Boolean)
  try {
    await update(id, {
      title: metaTitle.value || null,
      project: metaProject.value || null,
      domain: metaDomain.value || null,
      type: metaType.value || null,
      tags
    })
    // Update local doc reference — but only while this save's own document is still selected.
    // A flush from a document switch must not write the outgoing metadata onto the incoming
    // document's local state.
    if (props.documentId !== id) return
    if (doc.value) {
      doc.value = {
        ...doc.value,
        title: metaTitle.value || null,
        project: metaProject.value || null,
        domain: metaDomain.value || null,
        type: metaType.value || null,
        tags
      }
    }
    // Edits are persisted — let the live watcher resume syncing this doc.
    metaDirty.value = false
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Metadata save failed', description: err.data?.statusMessage ?? err.message })
  }
}

function scheduleMetaSave() {
  metaDirty.value = true
  if (metaSaveTimer.value) clearTimeout(metaSaveTimer.value)
  metaSaveTimer.value = setTimeout(() => saveMetadata(), 800)
}

// Tab close / reload can't be made to wait for an in-flight save, so warn instead — mirrors
// Editor.vue's own beforeunload guard, scoped to the metadata half of the form.
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (metaDirty.value) e.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))

onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  if (metaSaveTimer.value) {
    clearTimeout(metaSaveTimer.value)
    if (metaDirty.value) void saveMetadata()
  }
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
    <!-- Header. The badge row that used to live here echoed project/domain/tags directly above
         the very fields holding them — it existed to give the old collapsed <details> a summary,
         and became pure duplication once this turned into a permanent panel. The document's
         location is shown instead: information the panel genuinely lacked. -->
    <div class="space-y-1">
      <div class="flex items-center gap-2 text-xs text-muted">
        <UIcon
          name="i-lucide-info"
          class="size-3.5"
        />
        Metadata
      </div>
      <p
        v-if="metaPath"
        class="font-mono text-xs text-dimmed truncate"
        :title="metaPath"
      >
        {{ metaPath }}
      </p>
    </div>

    <!-- Title is the field that gets edited often; the rest is classification set once and
         rarely revisited, so it sits in its own group below a divider. -->
    <UFormField label="Title">
      <UInput
        v-model="metaTitle"
        placeholder="Document title"
        size="xs"
        class="w-full"
        @input="scheduleMetaSave"
      />
    </UFormField>

    <USeparator />

    <div class="flex flex-col gap-3">
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
        <!-- `@update:model-value` rather than `@input`: v-model's own setter is merged first,
             so the ref is written before this fires. (`scheduleMetaSave` only arms a timer that
             reads the refs when it fires, so ordering is not load-bearing here — but binding the
             model event keeps it correct even if that ever changes.) -->
        <UInputTags
          v-model="metaTags"
          placeholder="Add a tag…"
          size="xs"
          class="w-full"
          @update:model-value="scheduleMetaSave"
        />
      </UFormField>
    </div>
  </div>
</template>
