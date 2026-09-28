<script setup lang="ts">
/**
 * /jobs (cycle 74) — Bridget's scheduled and triggered jobs. Each job is a markdown file edited at
 * /jobs/[slug]; this table shows its trigger in plain English, the next fire time and the last
 * outcome, with an enabled switch per row (which rewrites the file's `enabled:` line).
 */
import type { TableColumn } from '@nuxt/ui'
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query'
import { formatAgo, formatInZone, formatRelative, outcomeColor } from '~/lib/jobs/display'
import { JOB_SLUG_RE, JOB_TEMPLATES, jobTemplate, type JobTemplateId } from '~/lib/jobs/templates'

definePageMeta({ title: 'Jobs' })

interface Job {
  id: string
  slug: string
  source: 'human' | 'agent'
  enabled: boolean
  triggerKind: string | null
  timezone: string | null
  description: string | null
  nextRunAt: string | null
  parseError: string | null
  lastRunAt: string | null
  lastOutcome: string | null
  consecutiveFailures: number
}

const toast = useToast()
const qc = useQueryClient()

const { data, error, isPending } = useQuery({ queryKey: ['jobs', 'list'], queryFn: () => $fetch<Job[]>('/api/jobs') })
const jobs = computed(() => data.value ?? [])

function errorMessage(e: unknown): string {
  const err = e as { data?: { statusMessage?: string }, message?: string }
  return err.data?.statusMessage ?? err.message ?? 'Unknown error'
}

watch(error, (err) => {
  if (err) toast.add({ color: 'error', title: 'Could not load jobs', description: errorMessage(err) })
})

const setEnabled = useMutation({
  mutationFn: (p: { slug: string, enabled: boolean }) => $fetch(`/api/jobs/${p.slug}/enabled`, { method: 'PUT', body: { enabled: p.enabled } }),
  onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  onError: (e: unknown) => toast.add({ color: 'error', title: 'Could not toggle job', description: errorMessage(e) })
})

// Relative times drift; re-render them every 30 s.
const now = ref(new Date())
useIntervalFn(() => {
  now.value = new Date()
}, 30_000)

const columns: TableColumn<Job>[] = [
  { accessorKey: 'slug', header: 'Job' },
  { accessorKey: 'description', header: 'Trigger' },
  { accessorKey: 'nextRunAt', header: 'Next run' },
  { accessorKey: 'lastOutcome', header: 'Last outcome' },
  { accessorKey: 'enabled', header: 'Enabled' }
]

// ── New job ──────────────────────────────────────────────────────────────────
const newOpen = ref(false)
const newSlug = ref('')
const newTemplate = ref<JobTemplateId>('heartbeat')
const creating = ref(false)
const createError = ref<string | null>(null)
const templateItems = JOB_TEMPLATES.map(t => ({ label: t.label, value: t.id, description: t.description }))

const slugProblem = computed(() => {
  const s = newSlug.value.trim()
  if (!s) return null
  if (!JOB_SLUG_RE.test(s)) return 'Use lowercase letters, digits and dashes, e.g. weekly-review'
  if (jobs.value.some(j => j.slug === s)) return `A job named "${s}" already exists`
  return null
})

function openNew() {
  newSlug.value = ''
  newTemplate.value = 'heartbeat'
  createError.value = null
  newOpen.value = true
}

async function createJob() {
  const slug = newSlug.value.trim()
  if (!slug || slugProblem.value) return
  creating.value = true
  createError.value = null
  try {
    await $fetch('/api/jobs', { method: 'POST', body: { slug, content: jobTemplate(newTemplate.value).content } })
    newOpen.value = false
    await qc.invalidateQueries({ queryKey: ['jobs', 'list'] })
    await navigateTo(`/jobs/${slug}`)
  } catch (e: unknown) {
    const err = e as { status?: number }
    createError.value = err.status === 409 ? `A job named "${slug}" already exists` : errorMessage(e)
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <UDashboardPanel
    id="jobs-panel"
    grow
  >
    <template #header>
      <UDashboardNavbar title="Jobs">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            icon="i-lucide-plus"
            size="xs"
            color="primary"
            label="New job"
            data-testid="new-job"
            @click="openNew"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p class="text-sm text-muted">
        Prompts Bridget runs on a schedule or when something happens. Each job is a markdown file:
        the frontmatter says when, the body says what. A job that has nothing to say replies NO_REPLY and stays silent.
      </p>

      <UTable
        :data="jobs"
        :columns="columns"
        :loading="isPending"
        data-testid="jobs-table"
      >
        <template #slug-cell="{ row }">
          <div
            class="flex items-center gap-2"
            :data-job="row.original.slug"
          >
            <ULink
              :to="`/jobs/${row.original.slug}`"
              class="font-medium text-highlighted"
            >
              {{ row.original.slug }}
            </ULink>
            <UBadge
              v-if="row.original.source === 'agent'"
              color="primary"
              variant="subtle"
              size="sm"
            >
              agent
            </UBadge>
            <UTooltip
              v-if="row.original.parseError"
              :text="row.original.parseError"
            >
              <UBadge
                color="error"
                variant="subtle"
                size="sm"
                icon="i-lucide-triangle-alert"
                data-testid="job-invalid"
              >
                invalid
              </UBadge>
            </UTooltip>
          </div>
        </template>

        <template #description-cell="{ row }">
          <span class="text-muted">{{ row.original.description ?? '—' }}</span>
        </template>

        <template #nextRunAt-cell="{ row }">
          <UTooltip
            v-if="row.original.enabled && row.original.nextRunAt"
            :text="formatInZone(row.original.nextRunAt, row.original.timezone)"
          >
            <span data-testid="job-next-run">{{ formatRelative(row.original.nextRunAt, now) }}</span>
          </UTooltip>
          <span
            v-else-if="row.original.enabled && row.original.triggerKind === 'event'"
            class="text-muted"
          >on event</span>
          <span
            v-else
            class="text-dimmed"
          >—</span>
        </template>

        <template #lastOutcome-cell="{ row }">
          <div
            v-if="row.original.lastOutcome"
            class="flex items-center gap-2"
          >
            <UBadge
              :color="outcomeColor(row.original.lastOutcome)"
              variant="subtle"
              size="sm"
              data-testid="job-last-outcome"
            >
              {{ row.original.lastOutcome }}
            </UBadge>
            <UTooltip
              v-if="row.original.lastRunAt"
              :text="formatInZone(row.original.lastRunAt, row.original.timezone)"
            >
              <span class="text-xs text-muted">{{ formatAgo(row.original.lastRunAt, now) }}</span>
            </UTooltip>
          </div>
          <span
            v-else
            class="text-dimmed"
          >never run</span>
        </template>

        <template #enabled-cell="{ row }">
          <USwitch
            :model-value="row.original.enabled"
            :aria-label="`${row.original.slug} enabled`"
            :data-testid="`job-enabled-${row.original.slug}`"
            @update:model-value="(v: boolean) => setEnabled.mutate({ slug: row.original.slug, enabled: v })"
          />
        </template>

        <template #empty>
          <div class="flex flex-col items-center justify-center gap-3 py-12 text-muted">
            <UIcon
              name="i-lucide-calendar-clock"
              class="size-12 text-dimmed"
            />
            <p class="text-sm">
              No jobs yet.
            </p>
          </div>
        </template>
      </UTable>

      <!-- Teleported, so its place in the tree is only to keep one template root. -->
      <UModal
        v-model:open="newOpen"
        title="New job"
        description="Starts disabled — turn it on once the schedule looks right."
      >
        <template #body>
          <form
            class="flex flex-col gap-4"
            @submit.prevent="createJob"
          >
            <UFormField
              label="Slug"
              required
              :error="slugProblem ?? createError ?? undefined"
            >
              <UInput
                v-model="newSlug"
                placeholder="weekly-review"
                autofocus
                class="w-full"
                data-testid="new-job-slug"
              />
            </UFormField>
            <UFormField
              label="Template"
              :description="jobTemplate(newTemplate).description"
            >
              <USelect
                v-model="newTemplate"
                :items="templateItems"
                class="w-full"
                data-testid="new-job-template"
              />
            </UFormField>
            <div class="flex justify-end gap-2">
              <UButton
                color="neutral"
                variant="ghost"
                label="Cancel"
                @click="newOpen = false"
              />
              <UButton
                type="submit"
                label="Create"
                :loading="creating"
                :disabled="!newSlug.trim() || !!slugProblem"
                data-testid="create-job"
              />
            </div>
          </form>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
