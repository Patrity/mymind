<script setup lang="ts">
/**
 * /skills (cycle 74) — the agent's skills, moved out of Settings. Each skill is a markdown file
 * edited at /skills/[slug]; the header carries the global kill switch (skills off = the agent
 * never loads any), each row an active switch.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query'
import { COMMAND_NAME_RE, RESERVED_COMMAND_NAMES } from '~~/shared/types/commands'
import { skillStarterMarkdown } from '~/lib/config/source'

definePageMeta({ title: 'Skills' })

interface Skill { id: string, name: string, description: string, whenToUse: string, active: boolean, source: 'human' | 'agent', updatedAt: string }

const toast = useToast()
const qc = useQueryClient()

const { data, error, isPending } = useQuery({ queryKey: ['skills', 'list'], queryFn: () => $fetch<Skill[]>('/api/skills') })
const skills = computed(() => data.value ?? [])

const { data: cfg } = useQuery({ queryKey: ['skills', 'enabled'], queryFn: () => $fetch<{ enabled: boolean }>('/api/settings/skills-enabled') })

function errorMessage(e: unknown): string {
  const err = e as { data?: { statusMessage?: string }, message?: string }
  return err.data?.statusMessage ?? err.message ?? 'Unknown error'
}

watch(error, (err) => {
  if (err) toast.add({ color: 'error', title: 'Could not load skills', description: errorMessage(err) })
})

const toggleEnabled = useMutation({
  mutationFn: (enabled: boolean) => $fetch('/api/settings/skills-enabled', { method: 'PUT', body: { enabled } }),
  onSuccess: () => qc.invalidateQueries({ queryKey: ['skills', 'enabled'] }),
  onError: (e: unknown) => toast.add({ color: 'error', title: 'Could not update the kill switch', description: errorMessage(e) })
})

const setActive = useMutation({
  mutationFn: (p: { name: string, active: boolean }) => $fetch(`/api/skills/${p.name}`, { method: 'PUT', body: { active: p.active } }),
  onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  onError: (e: unknown) => toast.add({ color: 'error', title: 'Could not toggle skill', description: errorMessage(e) })
})

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ── New skill ────────────────────────────────────────────────────────────────
// UModal's v-model:open takes a BOOLEAN — keep it separate from the form state.
const newOpen = ref(false)
const newName = ref('')
const creating = ref(false)
const createError = ref<string | null>(null)

const nameProblem = computed(() => {
  const n = newName.value.trim()
  if (!n) return null
  if (!COMMAND_NAME_RE.test(n)) return 'Use lowercase kebab-case, e.g. deploy-checklist'
  if (RESERVED_COMMAND_NAMES.includes(n)) return `"${n}" is a reserved command name`
  if (skills.value.some(s => s.name === n)) return `A skill named "${n}" already exists`
  return null
})

function openNew() {
  newName.value = ''
  createError.value = null
  newOpen.value = true
}

async function createSkill() {
  const name = newName.value.trim()
  if (!name || nameProblem.value) return
  creating.value = true
  createError.value = null
  try {
    // expectedHash null = create-only: a 409 means the name is taken, never an overwrite.
    await $fetch(`/api/skills/${name}/source`, { method: 'PUT', body: { content: skillStarterMarkdown(name), expectedHash: null } })
    newOpen.value = false
    await navigateTo(`/skills/${name}`)
  } catch (e: unknown) {
    const err = e as { status?: number }
    createError.value = err.status === 409 ? `A skill named "${name}" already exists` : errorMessage(e)
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <UDashboardPanel
    id="skills-panel"
    grow
  >
    <template #header>
      <UDashboardNavbar title="Skills">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <USwitch
            label="Skills enabled"
            :model-value="cfg?.enabled ?? true"
            :loading="toggleEnabled.isPending.value"
            data-testid="skills-kill-switch"
            @update:model-value="(v: boolean) => toggleEnabled.mutate(v)"
          />
          <UButton
            icon="i-lucide-plus"
            size="xs"
            color="primary"
            label="New skill"
            @click="openNew"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p class="text-sm text-muted">
        How-to guides the agent loads on demand instead of carrying in every prompt. Each one is a markdown
        file; the agent can write and revise them too, and every change is a revision you can revert.
      </p>

      <UAlert
        v-if="cfg && !cfg.enabled"
        color="warning"
        variant="subtle"
        icon="i-lucide-power-off"
        title="Skills are turned off"
        description="The agent loads none of them, and they are hidden from the / menu, until you switch them back on."
      />

      <div
        v-if="isPending"
        class="flex flex-col gap-3"
      >
        <USkeleton
          v-for="i in 3"
          :key="i"
          class="h-20 w-full"
        />
      </div>

      <div
        v-else-if="!skills.length && !error"
        class="flex flex-col items-center justify-center gap-3 py-12 text-muted"
      >
        <UIcon
          name="i-lucide-graduation-cap"
          class="size-12 text-dimmed"
        />
        <p class="text-sm">
          No skills yet.
        </p>
        <UButton
          size="sm"
          variant="outline"
          color="neutral"
          label="Write the first one"
          @click="openNew"
        />
      </div>

      <div
        v-else
        class="flex flex-col gap-3"
        data-testid="skills-list"
      >
        <UCard
          v-for="s in skills"
          :key="s.id"
          class="cursor-pointer hover:bg-elevated/40 transition-colors"
          :data-skill="s.name"
          @click="navigateTo(`/skills/${s.name}`)"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <ULink
                  :to="`/skills/${s.name}`"
                  class="font-medium truncate text-highlighted"
                  @click.stop
                >
                  {{ s.name }}
                </ULink>
                <UBadge
                  :color="s.source === 'agent' ? 'primary' : 'neutral'"
                  variant="subtle"
                  size="sm"
                >
                  {{ s.source }}
                </UBadge>
                <UBadge
                  v-if="!s.active"
                  color="warning"
                  variant="subtle"
                  size="sm"
                >
                  inactive
                </UBadge>
              </div>
              <p class="text-sm text-muted truncate">
                {{ s.description }}
              </p>
              <p class="text-xs text-dimmed truncate">
                {{ s.whenToUse }}
              </p>
              <p class="text-xs text-dimmed mt-1">
                Updated {{ formatDate(s.updatedAt) }}
              </p>
            </div>
            <USwitch
              :model-value="s.active"
              class="shrink-0"
              :aria-label="`${s.name} active`"
              @click.stop
              @update:model-value="(v: boolean) => setActive.mutate({ name: s.name, active: v })"
            />
          </div>
        </UCard>
      </div>

      <!-- Teleported, so its place in the tree is only to keep one template root. -->
      <UModal
        v-model:open="newOpen"
        title="New skill"
        description="The name is also its / command."
      >
        <template #body>
          <form
            class="flex flex-col gap-4"
            @submit.prevent="createSkill"
          >
            <UFormField
              label="Name"
              required
              :error="nameProblem ?? createError ?? undefined"
            >
              <UInput
                v-model="newName"
                placeholder="deploy-checklist"
                autofocus
                class="w-full"
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
                :disabled="!newName.trim() || !!nameProblem"
              />
            </div>
          </form>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
