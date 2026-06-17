<script setup lang="ts">
import type { ProjectDTO, TaskPriority } from '~~/shared/types/tasks'
import type { SessionListItem } from '~~/shared/types/session'
import type { MemoryScope } from '~~/shared/types/memory'

definePageMeta({ title: 'Project' })

const route = useRoute()
const slug = computed(() => route.params.slug as string)

// ── Data ──────────────────────────────────────────────────────────────────────
const { useProject } = useProjects()
const { data: project, isPending, error } = useProject(slug)

const notFound = computed(() => !isPending.value && (error.value != null || project.value == null))

// ── Tab data ──────────────────────────────────────────────────────────────────
const { useSessionList } = useSessions()
const { useTaskList } = useTasks()
const { useMemoryList } = useMemories()

const { data: sessionData, isPending: sessionsLoading, error: sessionsError } = useSessionList(
  () => ({ project: slug.value })
)
const sessions = computed(() => sessionData.value ?? [])

const { data: taskData, isPending: tasksLoading, error: tasksError } = useTaskList(slug)
const tasks = computed(() => taskData.value ?? [])

const { data: memoryData, isPending: memoriesLoading, error: memoriesError } = useMemoryList(
  () => ({ project: slug.value })
)
const memories = computed(() => memoryData.value ?? [])

// ── Edit modal ────────────────────────────────────────────────────────────────
const showEdit = ref(false)

function onSaved(updated: ProjectDTO) {
  if (updated.slug !== slug.value) {
    navigateTo('/projects/' + updated.slug, { replace: true })
  }
  // else: the live ['project', slug] query invalidation auto-refreshes the header
}

function onDeleted() {
  navigateTo('/projects')
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const diffMs = Date.now() - new Date(iso).getTime()
  const sec = Math.round(diffMs / 1000)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000], ['month', 2592000], ['day', 86400],
    ['hour', 3600], ['minute', 60], ['second', 1]
  ]
  for (const [unit, secs] of units) {
    if (Math.abs(sec) >= secs || unit === 'second') {
      return rtf.format(-Math.round(sec / secs), unit)
    }
  }
  return ''
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function sourceColor(source: string): 'primary' | 'info' | 'warning' | 'neutral' {
  if (source === 'claude-code') return 'primary'
  if (source === 'hermes') return 'info'
  if (source === 'bridget') return 'warning'
  return 'neutral'
}

function sessionLabel(s: SessionListItem): string {
  return s.title || s.summary || '(untitled session)'
}

const priorityColor: Record<TaskPriority, 'neutral' | 'warning' | 'error'> = {
  low: 'neutral',
  medium: 'warning',
  high: 'error'
}

const statusColor: Record<string, 'neutral' | 'primary' | 'success' | 'error'> = {
  todo: 'neutral',
  in_progress: 'primary',
  completed: 'success',
  blocked: 'error'
}

const scopeColor: Record<MemoryScope, 'primary' | 'info' | 'warning'> = {
  user: 'primary',
  agent: 'info',
  world: 'warning'
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
const activeTab = ref('sessions')

const tabItems = [
  { label: 'Sessions', value: 'sessions', slot: 'sessions' as const },
  { label: 'Tasks', value: 'tasks', slot: 'tasks' as const },
  { label: 'Memories', value: 'memories', slot: 'memories' as const }
]
</script>

<template>
  <UDashboardPanel
    id="project-detail"
    grow
  >
    <template #header>
      <UDashboardNavbar :title="project?.name ?? 'Project'">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UButton
            icon="i-lucide-arrow-left"
            to="/projects"
            color="neutral"
            variant="ghost"
            size="sm"
            aria-label="Back to projects"
          />
        </template>
        <template #right>
          <UButton
            v-if="project"
            icon="i-lucide-pencil"
            label="Edit"
            size="xs"
            color="neutral"
            variant="outline"
            @click="showEdit = true"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- Loading -->
      <div
        v-if="isPending"
        class="p-6 space-y-4 max-w-4xl mx-auto w-full"
      >
        <USkeleton class="h-8 w-48 rounded-full" />
        <USkeleton class="h-5 w-2/3" />
        <div class="grid grid-cols-3 gap-4 mt-4">
          <USkeleton
            v-for="i in 3"
            :key="i"
            class="h-24"
          />
        </div>
        <USkeleton class="h-10 w-full mt-4" />
        <USkeleton
          v-for="i in 4"
          :key="i"
          class="h-20 w-full"
        />
      </div>

      <!-- Not found -->
      <div
        v-else-if="notFound"
        class="flex flex-col items-center justify-center py-32 gap-4 text-center"
      >
        <UIcon
          name="i-lucide-folder-x"
          class="size-12 text-muted"
        />
        <p class="text-base font-semibold text-default">
          Project not found
        </p>
        <p class="text-sm text-muted">
          This project may have been deleted or the slug is invalid.
        </p>
        <UButton
          to="/projects"
          icon="i-lucide-arrow-left"
          color="primary"
          variant="soft"
          size="sm"
        >
          Back to projects
        </UButton>
      </div>

      <!-- Project content -->
      <div
        v-else-if="project"
        class="p-6 space-y-6 max-w-4xl mx-auto w-full"
      >
        <!-- ── Header block ── -->
        <div class="space-y-3">
          <!-- Badge + description -->
          <ProjectBadge
            :slug="project.slug"
            :name="project.name"
            :color="project.color"
            :to="false"
            class="text-sm!"
          />
          <p
            v-if="project.description"
            class="text-sm text-muted leading-relaxed"
          >
            {{ project.description }}
          </p>

          <!-- Metadata grid -->
          <div class="flex flex-wrap gap-x-6 gap-y-2 text-xs text-dimmed">
            <!-- Git remote -->
            <span
              v-if="project.gitRemoteKey"
              class="flex items-center gap-1 font-mono"
            >
              <UIcon name="i-lucide-git-branch" class="size-3.5 shrink-0" />
              {{ project.gitRemoteKey }}
            </span>

            <!-- Repository URL -->
            <UButton
              v-if="project.repositoryUrl"
              :to="project.repositoryUrl"
              target="_blank"
              rel="noopener"
              variant="link"
              size="xs"
              icon="i-lucide-code-2"
              :label="project.repositoryUrl"
              color="neutral"
              class="!p-0 !h-auto text-xs text-dimmed hover:text-default"
            />

            <!-- Production URL -->
            <UButton
              v-if="project.productionUrl"
              :to="project.productionUrl"
              target="_blank"
              rel="noopener"
              variant="link"
              size="xs"
              icon="i-lucide-globe"
              :label="project.productionUrl"
              color="neutral"
              class="!p-0 !h-auto text-xs text-dimmed hover:text-default"
            />

            <!-- Staging URL -->
            <UButton
              v-if="project.stagingUrl"
              :to="project.stagingUrl"
              target="_blank"
              rel="noopener"
              variant="link"
              size="xs"
              icon="i-lucide-flask-conical"
              :label="project.stagingUrl"
              color="neutral"
              class="!p-0 !h-auto text-xs text-dimmed hover:text-default"
            />

            <!-- Local paths -->
            <span
              v-if="project.localPaths.length"
              class="flex items-center gap-1 font-mono"
            >
              <UIcon name="i-lucide-folder" class="size-3.5 shrink-0" />
              {{ project.localPaths.join(', ') }}
            </span>

            <!-- Dates -->
            <span class="flex items-center gap-1">
              <UIcon name="i-lucide-calendar" class="size-3.5 shrink-0" />
              Created {{ formatDate(project.createdAt) }}
            </span>
            <span
              v-if="project.lastActivityAt"
              class="flex items-center gap-1"
            >
              <UIcon name="i-lucide-activity" class="size-3.5 shrink-0" />
              Active {{ relativeTime(project.lastActivityAt) }}
            </span>
          </div>

          <!-- Aliases -->
          <div
            v-if="project.aliases.length"
            class="flex flex-wrap gap-1.5"
          >
            <UBadge
              v-for="alias in project.aliases"
              :key="alias"
              :label="alias"
              color="neutral"
              variant="outline"
              size="xs"
            />
          </div>
        </div>

        <!-- ── Stats row ── -->
        <div class="grid grid-cols-3 gap-4">
          <div class="rounded-lg border border-default bg-elevated/30 p-4 text-center space-y-1">
            <p class="text-2xl font-bold text-highlighted">
              {{ project.sessionCount }}
            </p>
            <p class="text-xs text-muted flex items-center justify-center gap-1">
              <UIcon name="i-lucide-history" class="size-3.5" />
              Sessions
            </p>
          </div>
          <div class="rounded-lg border border-default bg-elevated/30 p-4 text-center space-y-1">
            <p class="text-2xl font-bold text-highlighted">
              {{ project.memoryCount }}
            </p>
            <p class="text-xs text-muted flex items-center justify-center gap-1">
              <UIcon name="i-lucide-brain" class="size-3.5" />
              Memories
            </p>
          </div>
          <div class="rounded-lg border border-default bg-elevated/30 p-4 text-center space-y-1">
            <p class="text-2xl font-bold text-highlighted">
              {{ project.taskCount }}
            </p>
            <p class="text-xs text-muted flex items-center justify-center gap-1">
              <UIcon name="i-lucide-check-square" class="size-3.5" />
              Tasks
            </p>
          </div>
        </div>

        <!-- ── Tabs ── -->
        <UTabs
          v-model="activeTab"
          :items="tabItems"
          class="w-full"
        >
          <!-- Sessions tab -->
          <template #sessions>
            <div class="mt-4 space-y-3">
              <!-- Loading -->
              <div
                v-if="sessionsLoading"
                class="space-y-3"
              >
                <USkeleton
                  v-for="i in 3"
                  :key="i"
                  class="h-20 w-full rounded-lg"
                />
              </div>

              <!-- Error -->
              <div
                v-else-if="sessionsError"
                class="flex items-center gap-2 text-sm text-error py-4"
              >
                <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0" />
                Failed to load sessions.
              </div>

              <!-- Empty -->
              <div
                v-else-if="sessions.length === 0"
                class="flex flex-col items-center justify-center py-12 gap-3 text-center"
              >
                <UIcon name="i-lucide-history" class="size-10 text-muted" />
                <p class="text-sm text-muted">
                  No sessions yet for this project.
                </p>
              </div>

              <!-- Session rows -->
              <UCard
                v-for="session in sessions"
                v-else
                :key="session.id"
                class="cursor-pointer hover:bg-elevated/50 transition-colors"
                @click="navigateTo('/sessions/' + session.id)"
              >
                <div class="flex items-start justify-between gap-3 flex-wrap">
                  <div class="min-w-0 flex-1 space-y-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <UBadge
                        :label="session.source"
                        :color="sourceColor(session.source)"
                        variant="subtle"
                        size="xs"
                      />
                    </div>
                    <p class="text-sm font-medium text-default truncate leading-snug">
                      {{ sessionLabel(session) }}
                    </p>
                  </div>
                  <p class="text-xs text-dimmed shrink-0 mt-0.5">
                    {{ relativeTime(session.lastActive) }}
                  </p>
                </div>
                <div class="mt-2 flex items-center gap-4 flex-wrap text-xs text-muted">
                  <span class="flex items-center gap-1">
                    <UIcon name="i-lucide-message-circle" class="size-3.5" />
                    {{ session.messageCount }} messages
                  </span>
                  <span class="flex items-center gap-1">
                    <UIcon name="i-lucide-wrench" class="size-3.5" />
                    {{ session.toolCount }} tools
                  </span>
                  <span class="flex items-center gap-1">
                    <UIcon name="i-lucide-arrow-up" class="size-3.5 text-info" />
                    {{ formatTokens(session.inputTokens) }}
                  </span>
                  <span class="flex items-center gap-1">
                    <UIcon name="i-lucide-arrow-down" class="size-3.5 text-success" />
                    {{ formatTokens(session.outputTokens) }}
                  </span>
                  <span class="flex items-center gap-1">
                    <UIcon name="i-lucide-calendar" class="size-3.5" />
                    {{ formatDate(session.startedAt) }}
                  </span>
                </div>
              </UCard>
            </div>
          </template>

          <!-- Tasks tab -->
          <template #tasks>
            <div class="mt-4 space-y-3">
              <!-- Loading -->
              <div
                v-if="tasksLoading"
                class="space-y-3"
              >
                <USkeleton
                  v-for="i in 3"
                  :key="i"
                  class="h-16 w-full rounded-lg"
                />
              </div>

              <!-- Error -->
              <div
                v-else-if="tasksError"
                class="flex items-center gap-2 text-sm text-error py-4"
              >
                <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0" />
                Failed to load tasks.
              </div>

              <!-- Empty -->
              <div
                v-else-if="tasks.length === 0"
                class="flex flex-col items-center justify-center py-12 gap-3 text-center"
              >
                <UIcon name="i-lucide-check-square" class="size-10 text-muted" />
                <p class="text-sm text-muted">
                  No tasks yet for this project.
                </p>
              </div>

              <!-- Task rows (no per-task detail page yet — rows link to /tasks; TODO: add per-task detail page) -->
              <div
                v-for="task in tasks"
                v-else
                :key="task.id"
                class="flex items-center gap-3 px-4 py-3 rounded-lg border border-default bg-elevated/30 hover:bg-elevated/50 transition-colors"
              >
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-medium text-default truncate">
                    {{ task.title }}
                  </p>
                  <div
                    v-if="task.dueDate"
                    class="text-xs text-dimmed mt-0.5"
                  >
                    Due {{ formatDate(task.dueDate) }}
                  </div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <UBadge
                    :label="task.status.replace('_', ' ')"
                    :color="statusColor[task.status] ?? 'neutral'"
                    variant="subtle"
                    size="xs"
                  />
                  <UBadge
                    :label="task.priority"
                    :color="priorityColor[task.priority]"
                    variant="outline"
                    size="xs"
                  />
                </div>
              </div>
            </div>
          </template>

          <!-- Memories tab -->
          <template #memories>
            <div class="mt-4 space-y-3">
              <!-- Loading -->
              <div
                v-if="memoriesLoading"
                class="space-y-3"
              >
                <USkeleton
                  v-for="i in 3"
                  :key="i"
                  class="h-20 w-full rounded-lg"
                />
              </div>

              <!-- Error -->
              <div
                v-else-if="memoriesError"
                class="flex items-center gap-2 text-sm text-error py-4"
              >
                <UIcon name="i-lucide-alert-circle" class="size-4 shrink-0" />
                Failed to load memories.
              </div>

              <!-- Empty -->
              <div
                v-else-if="memories.length === 0"
                class="flex flex-col items-center justify-center py-12 gap-3 text-center"
              >
                <UIcon name="i-lucide-brain" class="size-10 text-muted" />
                <p class="text-sm text-muted">
                  No memories yet for this project.
                </p>
              </div>

              <!-- Memory rows (no per-memory detail page — non-navigating; TODO: add per-memory detail page) -->
              <div
                v-for="mem in memories"
                v-else
                :key="mem.id"
                class="flex flex-col gap-2 px-4 py-3 rounded-lg border border-default bg-elevated/30"
              >
                <div class="flex items-start justify-between gap-2">
                  <div class="flex items-center gap-2 flex-wrap min-w-0">
                    <UBadge
                      :label="mem.scope"
                      :color="scopeColor[mem.scope]"
                      variant="subtle"
                      size="xs"
                    />
                    <UBadge
                      v-if="mem.reviewedAt"
                      label="reviewed"
                      color="success"
                      variant="subtle"
                      size="xs"
                    />
                  </div>
                  <p class="text-xs text-dimmed shrink-0">
                    {{ formatDate(mem.sourceDate ?? mem.createdAt) }}
                  </p>
                </div>
                <p class="text-sm text-default leading-relaxed line-clamp-3">
                  {{ mem.content }}
                </p>
                <div
                  v-if="mem.tags.length"
                  class="flex flex-wrap gap-1"
                >
                  <UBadge
                    v-for="tag in mem.tags"
                    :key="tag"
                    :label="tag"
                    color="neutral"
                    variant="subtle"
                    size="xs"
                  />
                </div>
              </div>
            </div>
          </template>
        </UTabs>
      </div>
    </template>
  </UDashboardPanel>

  <!-- Edit modal -->
  <ProjectEditModal
    v-if="project"
    v-model:open="showEdit"
    :project="project"
    @saved="onSaved"
    @deleted="onDeleted"
  />
</template>
