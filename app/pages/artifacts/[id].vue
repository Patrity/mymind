<script setup lang="ts">
/**
 * /artifacts/<uuid> (cycle 87) — one artifact: sandboxed preview, metadata editing, version history
 * with rollback. The route param is always the UUID so live invalidation keys match.
 */
import { formatBytes, formSyncFor, type ArtifactFormSync } from '~/lib/artifacts/display'

definePageMeta({ title: 'Artifact' })

const route = useRoute()
const id = computed(() => String(route.params.id))
const toast = useToast()
const { data: artifact, isPending, error } = useArtifactDetail(id)
const projects = useProjects().useProjectList()
const project = computed(() => (artifact.value?.projectId ? projects.data.value?.find(p => p.id === artifact.value!.projectId) ?? null : null))

function messageOf(e: unknown): string {
  const x = e as { data?: { message?: string, statusMessage?: string }, message?: string }
  return x.data?.message ?? x.data?.statusMessage ?? x.message ?? 'Unknown error'
}

const form = reactive({ title: '', description: '', slug: '' })
// Live refetches must not clobber unsaved typing — formSyncFor decides (a different artifact, or a form
// that still matches what we last synced / already matches the incoming artifact, takes the refetch).
let synced: ArtifactFormSync | null = null
watch(artifact, (a) => {
  if (!a) return
  const next = formSyncFor(form, synced, a)
  if (!next) return
  form.title = next.title
  form.description = next.description
  form.slug = next.slug
  synced = next
}, { immediate: true })
const dirty = computed(() => !!artifact.value && (
  form.title !== artifact.value.title || form.description !== (artifact.value.description ?? '') || form.slug !== artifact.value.slug
))

const saveError = ref<string | null>(null)
const saving = ref(false)
async function save() {
  if (!artifact.value) return
  saveError.value = null
  saving.value = true
  try {
    const patch: { title?: string, description?: string | null, slug?: string } = {}
    if (form.title !== artifact.value.title) patch.title = form.title
    if (form.description !== (artifact.value.description ?? '')) patch.description = form.description || null
    if (form.slug !== artifact.value.slug) patch.slug = form.slug
    const sent: ArtifactFormSync = { id: artifact.value.id, title: form.title, description: form.description, slug: form.slug }
    await updateArtifact(sent.id, patch)
    // What the server now holds: later remote edits see an untouched form and sync in.
    synced = sent
    toast.add({ color: 'success', title: 'Saved' })
  } catch (e) {
    saveError.value = messageOf(e)
  } finally {
    saving.value = false
  }
}

async function setPublic(isPublic: boolean) {
  if (!artifact.value) return
  try {
    await updateArtifact(artifact.value.id, { isPublic })
  } catch (e) {
    toast.add({ color: 'error', title: 'Could not change visibility', description: messageOf(e) })
  }
}

const rollingBack = ref<number | null>(null)
async function rollback(v: number) {
  if (!artifact.value) return
  rollingBack.value = v
  try {
    await updateArtifact(artifact.value.id, { rollbackTo: v })
    toast.add({ color: 'success', title: `Rolled back to v${v}` })
  } catch (e) {
    toast.add({ color: 'error', title: 'Could not roll back', description: messageOf(e) })
  } finally {
    rollingBack.value = null
  }
}

async function copyLink() {
  if (!artifact.value) return
  try {
    await navigator.clipboard.writeText(new URL(artifact.value.url, window.location.origin).toString())
    toast.add({ color: 'success', title: 'Link copied' })
  } catch {
    toast.add({ color: 'error', title: 'Could not copy the link' })
  }
}
</script>

<template>
  <UDashboardPanel
    id="artifact-detail-panel"
    grow
  >
    <template #header>
      <UDashboardNavbar :title="artifact?.title ?? 'Artifact'">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UButton
            to="/artifacts"
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="ghost"
            size="xs"
            aria-label="Back to artifacts"
          />
        </template>
        <template #right>
          <template v-if="artifact">
            <USwitch
              :model-value="artifact.isPublic"
              :label="artifact.isPublic ? 'Public' : 'Private'"
              data-testid="artifact-detail-public"
              @update:model-value="setPublic"
            />
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              icon="i-lucide-external-link"
              label="Open"
              :to="artifact.url"
              target="_blank"
              external
            />
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              icon="i-lucide-link"
              label="Copy link"
              @click="copyLink"
            />
          </template>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p
        v-if="isPending"
        class="text-sm text-muted"
      >
        Loading…
      </p>
      <p
        v-else-if="error || !artifact"
        class="text-sm text-error"
      >
        Artifact not found.
      </p>
      <template v-else>
        <p class="font-mono text-xs text-muted">
          /artifact/{{ artifact.slug }}/
        </p>

        <div class="h-[70vh] w-full">
          <ArtifactsFrame
            :artifact-id="artifact.id"
            :title="artifact.title"
            :version="artifact.currentVersion"
          />
        </div>

        <div class="grid gap-6 lg:grid-cols-2">
          <section class="flex flex-col gap-3">
            <h2 class="text-sm font-semibold text-highlighted">
              Details
            </h2>
            <UFormField label="Title">
              <UInput
                v-model="form.title"
                class="w-full"
                data-testid="artifact-title"
              />
            </UFormField>
            <UFormField label="Description">
              <UTextarea
                v-model="form.description"
                class="w-full"
                :rows="3"
              />
            </UFormField>
            <UFormField label="Slug">
              <UInput
                v-model="form.slug"
                class="w-full font-mono"
                data-testid="artifact-slug"
              />
            </UFormField>
            <UAlert
              v-if="saveError"
              color="error"
              variant="subtle"
              :description="saveError"
              data-testid="artifact-save-error"
            />
            <div>
              <UButton
                label="Save"
                :disabled="!dirty"
                :loading="saving"
                data-testid="artifact-save"
                @click="save"
              />
            </div>
            <div class="flex flex-col gap-1 text-sm">
              <ULink
                v-if="project"
                :to="`/projects/${project.slug}`"
                class="text-primary"
              >
                Project: {{ project.name }}
              </ULink>
              <ULink
                v-if="artifact.conversationId"
                :to="`/agent?c=${artifact.conversationId}`"
                class="text-primary"
              >
                Source conversation
              </ULink>
            </div>
          </section>

          <section class="flex flex-col gap-3">
            <h2 class="text-sm font-semibold text-highlighted">
              Versions
            </h2>
            <ul class="flex flex-col divide-y divide-default rounded-md border border-default">
              <li
                v-for="v in artifact.versions"
                :key="v.id"
                class="flex items-center gap-3 px-3 py-2 text-sm"
                :data-testid="`artifact-version-${v.version}`"
              >
                <span class="font-medium tabular-nums">v{{ v.version }}</span>
                <UBadge
                  v-if="v.current"
                  color="primary"
                  variant="subtle"
                  size="sm"
                  label="current"
                />
                <span class="min-w-0 flex-1 truncate text-xs text-muted">
                  {{ v.fileCount }} {{ v.fileCount === 1 ? 'file' : 'files' }} · {{ formatBytes(v.totalBytes) }} · {{ new Date(v.createdAt).toLocaleString() }}
                </span>
                <UButton
                  v-if="!v.current"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  label="Roll back"
                  :loading="rollingBack === v.version"
                  @click="rollback(v.version)"
                />
              </li>
            </ul>
          </section>
        </div>
      </template>
    </template>
  </UDashboardPanel>
</template>
