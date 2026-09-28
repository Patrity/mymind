/**
 * Load + explicit-save of a skill's or job's whole markdown (cycle 74), shared by
 * /skills/[slug] and /jobs/[slug]. No autosave: invalid content is rejected at write time, so a
 * save is a deliberate act (Save button / ⌘S).
 *
 * - Every save is a CAS write: it sends the `contentHash` it last loaded as `expectedHash`.
 * - 409 → `conflict` holds the server's copy; the page offers "Load theirs" (discardToServer)
 *   and "Overwrite" (overwrite — re-saves ours against their hash).
 * - 400 → `error` holds the validation message, shown inline; nothing is saved.
 * - A live write elsewhere refetches the source (its key sits under the kind's live-invalidated
 *   base, see configEndpoints): with no local edits it is adopted silently, otherwise
 *   `changedElsewhere` is raised and the local edits are kept.
 *
 * The decisions themselves live in app/lib/config/source.ts (unit-tested).
 */
import { useQuery, useQueryClient } from '@tanstack/vue-query'
// Explicit (not auto-)imports so the composable also runs under plain vitest.
import { computed, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import {
  classifySaveError, configEndpoints, reconcileSnapshot, toSnapshot,
  type ConfigKind, type SourceSnapshot
} from '~/lib/config/source'

export function useConfigSource(kind: ConfigKind, slug: MaybeRefOrGetter<string>) {
  const qc = useQueryClient()
  const slugValue = computed(() => toValue(slug))
  const endpoints = computed(() => configEndpoints(kind, slugValue.value))
  const queryKey = computed(() => [endpoints.value.queryBase, 'source', slugValue.value])

  const query = useQuery({
    queryKey,
    // `raw` keeps the whole GET response (skill: source/active/updatedAt; job: the jobs envelope)
    // so a page can read its header metadata off this one request.
    queryFn: async () => {
      const raw = await $fetch<unknown>(endpoints.value.source)
      return { ...toSnapshot(raw), raw }
    },
    enabled: computed(() => !!slugValue.value)
  })

  const content = ref('')
  const savedContent = ref<string | null>(null)
  const savedHash = ref<string | null>(null)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const conflict = ref<SourceSnapshot | null>(null)
  const changedElsewhere = ref(false)

  const loaded = computed(() => savedHash.value !== null)
  const dirty = computed(() => savedContent.value !== null && content.value !== savedContent.value)

  function adopt(snap: SourceSnapshot) {
    content.value = snap.content
    savedContent.value = snap.content
    savedHash.value = snap.contentHash
    changedElsewhere.value = false
    conflict.value = null
    error.value = null
  }

  // A rejected save's message describes the text as it was sent; once the user edits again it no
  // longer applies, so it clears (the next save re-validates).
  watch(content, () => {
    if (error.value) error.value = null
  })

  // A different slug is a different document: start over.
  watch(slugValue, () => {
    content.value = ''
    savedContent.value = null
    savedHash.value = null
    changedElsewhere.value = false
    conflict.value = null
    error.value = null
  })

  watch(() => query.data.value, (snap) => {
    // A refetch that lands mid-save is the echo of that save (or a race the CAS will report);
    // the save's own result settles the state.
    if (!snap || saving.value) return
    const action = reconcileSnapshot(snap, { savedHash: savedHash.value, dirty: dirty.value })
    if (action === 'adopt') adopt(snap)
    else if (action === 'flag') changedElsewhere.value = true
  }, { immediate: true })

  async function save(): Promise<boolean> {
    if (saving.value || savedHash.value === null) return false
    saving.value = true
    error.value = null
    const sent = content.value
    try {
      const res = await $fetch(endpoints.value.save, {
        method: 'PUT',
        body: { content: sent, expectedHash: savedHash.value }
      })
      const snap = toSnapshot(res)
      savedHash.value = snap.contentHash
      savedContent.value = sent
      conflict.value = null
      changedElsewhere.value = false
      // Our own write is now the server copy; keep the old `raw` until the refetch below lands.
      qc.setQueryData(queryKey.value, (old: { raw?: unknown } | undefined) => ({ ...snap, raw: old?.raw }))
      void qc.invalidateQueries({ queryKey: queryKey.value })
      void qc.invalidateQueries({ queryKey: [endpoints.value.queryBase, 'revisions', slugValue.value] })
      return true
    } catch (err) {
      const f = classifySaveError(err)
      if (f.kind === 'conflict') conflict.value = f.current
      else error.value = f.message
      return false
    } finally {
      saving.value = false
    }
  }

  /** Throws local edits away in favour of the server copy (the conflict's, when there is one). */
  function discardToServer() {
    const snap = conflict.value ?? query.data.value
    if (snap) adopt(snap)
  }

  /** Resolves a conflict by re-saving our content against the server's current hash. */
  async function overwrite(): Promise<boolean> {
    if (!conflict.value) return false
    savedHash.value = conflict.value.contentHash
    conflict.value = null
    return save()
  }

  /** Refetches and adopts the server copy, discarding local edits. */
  async function reload(): Promise<void> {
    const r = await query.refetch()
    if (r.data) adopt(r.data)
  }

  const raw = computed(() => query.data.value?.raw)

  return {
    raw, content, dirty, saving, error, conflict, changedElsewhere, loaded,
    isPending: query.isPending, loadError: query.error,
    save, discardToServer, overwrite, reload
  }
}
