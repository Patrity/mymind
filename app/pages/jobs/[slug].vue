<script setup lang="ts">
/**
 * /jobs/[slug] (cycle 74) — edit one job's whole markdown on the shared MarkdownConfigEditor,
 * with explicit save (button / ⌘S, via useConfigSource's CAS write), its status (validation,
 * next fire times, Run now, recent runs) and its revision history.
 */
import { useQueryClient } from '@tanstack/vue-query'
import type { JobRunRow } from '~/lib/jobs/display'

definePageMeta({ title: 'Job' })

interface JobEnvelope {
  job: {
    slug: string
    source: 'human' | 'agent'
    enabled: boolean
    triggerKind: string | null
    timezone: string | null
    description: string | null
    parseError: string | null
    consecutiveFailures: number
  }
  nextFireTimes: string[]
  runs: JobRunRow[]
}

const route = useRoute()
const toast = useToast()
const qc = useQueryClient()
const slug = computed(() => String(route.params.slug ?? ''))

const {
  raw, content, dirty, saving, error, conflict, changedElsewhere, loaded, loadError,
  save, discardToServer, overwrite, reload
} = useConfigSource('job', slug)

// Everything but the markdown comes off the composable's own GET envelope. After a save the
// envelope is briefly the pre-save one until the refetch lands.
const envelope = computed(() => raw.value as JobEnvelope | undefined)
const job = computed(() => envelope.value?.job ?? null)

useHead({ title: computed(() => `${slug.value} · Jobs`) })

function errorMessage(e: unknown): string {
  const err = e as { data?: { statusMessage?: string }, message?: string }
  return err.data?.statusMessage ?? err.message ?? 'Unknown error'
}

async function onSave() {
  if (!dirty.value) return
  if (await save()) toast.add({ color: 'success', title: 'Job saved' })
}

async function onOverwrite() {
  if (await overwrite()) toast.add({ color: 'success', title: 'Job saved', description: 'Overwrote the other version' })
}

// The switch rewrites the file's `enabled:` line on the server, so it is off while there are
// unsaved edits (they would otherwise collide with that write).
const togglingEnabled = ref(false)
async function setEnabled(enabled: boolean) {
  if (dirty.value) return
  togglingEnabled.value = true
  try {
    await $fetch(`/api/jobs/${slug.value}/enabled`, { method: 'PUT', body: { enabled } })
    await qc.invalidateQueries({ queryKey: ['jobs'] })
  } catch (e: unknown) {
    toast.add({ color: 'error', title: `Could not ${enabled ? 'enable' : 'disable'} the job`, description: errorMessage(e) })
  } finally {
    togglingEnabled.value = false
  }
}

// Leaving with unsaved edits: the in-app route guard and the tab-close guard.
onBeforeRouteLeave(() => {
  if (dirty.value && !window.confirm('Discard unsaved changes to this job?')) return false
})
useEventListener('beforeunload', (e: BeforeUnloadEvent) => {
  if (dirty.value) e.preventDefault()
})

// ── Delete ───────────────────────────────────────────────────────────────────
const deleteOpen = ref(false)
const deleting = ref(false)
async function confirmDelete() {
  deleting.value = true
  try {
    await $fetch(`/api/jobs/${slug.value}`, { method: 'DELETE' })
    deleteOpen.value = false
    discardToServer() // nothing left to be dirty about, so the leave guard stays quiet
    await qc.invalidateQueries({ queryKey: ['jobs', 'list'] })
    toast.add({ color: 'success', title: `Deleted ${slug.value}` })
    await navigateTo('/jobs')
  } catch (e: unknown) {
    toast.add({ color: 'error', title: 'Delete failed', description: errorMessage(e) })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <UDashboardPanel
    id="job-editor"
    grow
    :ui="{ body: '!p-0' }"
  >
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #title>
          <div class="flex items-center gap-2 min-w-0">
            <ULink
              to="/jobs"
              class="text-muted hover:text-default"
            >
              Jobs
            </ULink>
            <UIcon
              name="i-lucide-chevron-right"
              class="size-4 text-dimmed shrink-0"
            />
            <span
              class="truncate text-highlighted"
              data-testid="job-title"
            >{{ slug }}</span>
            <UBadge
              v-if="job"
              :color="job.source === 'agent' ? 'primary' : 'neutral'"
              variant="subtle"
              size="sm"
            >
              {{ job.source }}
            </UBadge>
            <UBadge
              v-if="dirty"
              color="warning"
              variant="soft"
              size="sm"
              data-testid="dirty-badge"
            >
              unsaved
            </UBadge>
            <UBadge
              v-if="changedElsewhere"
              color="info"
              variant="soft"
              size="sm"
              data-testid="changed-elsewhere"
            >
              changed elsewhere
            </UBadge>
          </div>
        </template>
        <template #right>
          <UTooltip
            :text="dirty ? 'Save or discard your edits first' : (job?.enabled ? 'Disable this job' : 'Enable this job')"
          >
            <USwitch
              label="Enabled"
              :model-value="job?.enabled ?? false"
              :loading="togglingEnabled"
              :disabled="!job || dirty"
              data-testid="job-enabled"
              @update:model-value="(v: boolean) => { void setEnabled(v) }"
            />
          </UTooltip>
          <UButton
            icon="i-lucide-trash-2"
            size="xs"
            color="error"
            variant="ghost"
            aria-label="Delete job"
            :disabled="!loaded"
            @click="deleteOpen = true"
          />
          <UButton
            icon="i-lucide-save"
            size="xs"
            color="primary"
            label="Save"
            :loading="saving"
            :disabled="!dirty"
            data-testid="save-job"
            @click="onSave"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert
        v-if="loadError"
        class="m-4"
        color="error"
        icon="i-lucide-alert-circle"
        title="Could not load this job"
        :description="String((loadError as { data?: { statusMessage?: string } }).data?.statusMessage ?? loadError)"
      />

      <div
        v-else
        class="flex h-full min-h-0"
      >
        <div class="flex-1 min-w-0 flex flex-col min-h-0">
          <!-- Mounted only once the source is loaded: on a hard page load CodeMirror otherwise
               never attaches (see /skills/[slug]). -->
          <div
            v-if="!loaded"
            class="p-4 flex flex-col gap-2"
          >
            <USkeleton
              v-for="i in 6"
              :key="i"
              class="h-4 w-full"
            />
          </div>
          <MarkdownConfigEditor
            v-else
            v-model="content"
            view-mode-cookie="mm.config.viewMode"
            default-view-mode="split"
            @save="onSave"
          >
            <template #header>
              <UIcon
                name="i-lucide-calendar-clock"
                class="size-4 text-dimmed shrink-0"
              />
              <span class="text-xs text-muted truncate">{{ slug }}.md</span>
            </template>

            <template #banner>
              <UAlert
                v-if="error"
                class="rounded-none"
                color="error"
                variant="subtle"
                icon="i-lucide-circle-x"
                title="Not saved"
                :description="error"
                data-testid="save-error"
              />
              <UAlert
                v-if="conflict"
                class="rounded-none"
                color="warning"
                variant="subtle"
                icon="i-lucide-git-compare"
                title="This job was changed elsewhere"
                description="Your save was not applied. Load their version (your edits are discarded) or overwrite it with yours."
                data-testid="save-conflict"
                :actions="[
                  { label: 'Load theirs', color: 'neutral', variant: 'outline', onClick: () => discardToServer() },
                  { label: 'Overwrite', color: 'warning', onClick: () => { void onOverwrite() } }
                ]"
              />
              <UAlert
                v-else-if="changedElsewhere"
                class="rounded-none"
                color="info"
                variant="subtle"
                icon="i-lucide-refresh-cw"
                title="Someone else saved this job while you were editing"
                description="Your edits are kept. Saving now will report a conflict you can resolve."
                :actions="[{ label: 'Discard mine and reload', color: 'neutral', variant: 'outline', onClick: () => { void reload() } }]"
              />
            </template>
          </MarkdownConfigEditor>
        </div>

        <div class="w-96 shrink-0 border-l border-default min-h-0 hidden lg:flex flex-col">
          <div class="shrink-0 max-h-[60%] overflow-auto border-b border-default">
            <ConfigJobStatusPanel
              :job="job"
              :next-fire-times="envelope?.nextFireTimes ?? []"
              :runs="envelope?.runs ?? []"
              :save-error="error"
            />
          </div>
          <div class="flex-1 min-h-0">
            <ConfigRevisionsPanel
              kind="job"
              :dirty="dirty"
              :slug="slug"
              @reverted="reload"
            />
          </div>
        </div>
      </div>

      <!-- Teleported, so its place in the tree is only to keep one template root. -->
      <UModal
        v-model:open="deleteOpen"
        :title="`Delete ${slug}?`"
        description="The job stops firing and disappears from /jobs. Its revisions and past runs are kept."
      >
        <template #footer>
          <div class="flex justify-end gap-2 w-full">
            <UButton
              color="neutral"
              variant="ghost"
              label="Cancel"
              @click="deleteOpen = false"
            />
            <UButton
              color="error"
              label="Delete"
              :loading="deleting"
              @click="confirmDelete"
            />
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
