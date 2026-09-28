<script setup lang="ts">
/**
 * /skills/[slug] (cycle 74) — edit one skill's whole markdown on the shared MarkdownConfigEditor,
 * with explicit save (button / ⌘S, via useConfigSource's CAS write) and its revision history.
 */
import { useQueryClient } from '@tanstack/vue-query'

definePageMeta({ title: 'Skill' })

interface SkillSource { content: string, contentHash: string, active: boolean, source: 'human' | 'agent', updatedAt: string }

const route = useRoute()
const toast = useToast()
const qc = useQueryClient()
const slug = computed(() => String(route.params.slug ?? ''))

const {
  raw, content, dirty, saving, error, conflict, changedElsewhere, loaded, loadError,
  save, discardToServer, overwrite, reload
} = useConfigSource('skill', slug)

// Header metadata (source/active) off the composable's own GET.
const skillMeta = computed(() => raw.value as SkillSource | undefined)

useHead({ title: computed(() => `${slug.value} · Skills`) })

async function onSave() {
  if (!dirty.value) return
  if (await save()) toast.add({ color: 'success', title: 'Skill saved' })
}

async function onOverwrite() {
  if (await overwrite()) toast.add({ color: 'success', title: 'Skill saved', description: 'Overwrote the other version' })
}

// Leaving with unsaved edits: the in-app route guard and the tab-close guard.
onBeforeRouteLeave(() => {
  if (dirty.value && !window.confirm('Discard unsaved changes to this skill?')) return false
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
    await $fetch(`/api/skills/${slug.value}`, { method: 'DELETE' })
    deleteOpen.value = false
    discardToServer() // nothing left to be dirty about, so the leave guard stays quiet
    await qc.invalidateQueries({ queryKey: ['skills', 'list'] })
    toast.add({ color: 'success', title: `Deleted ${slug.value}` })
    await navigateTo('/skills')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Delete failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <UDashboardPanel
    id="skill-editor"
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
              to="/skills"
              class="text-muted hover:text-default"
            >
              Skills
            </ULink>
            <UIcon
              name="i-lucide-chevron-right"
              class="size-4 text-dimmed shrink-0"
            />
            <span
              class="truncate text-highlighted"
              data-testid="skill-title"
            >{{ slug }}</span>
            <UBadge
              v-if="skillMeta"
              :color="skillMeta.source === 'agent' ? 'primary' : 'neutral'"
              variant="subtle"
              size="sm"
            >
              {{ skillMeta.source }}
            </UBadge>
            <UBadge
              v-if="skillMeta && !skillMeta.active"
              color="warning"
              variant="subtle"
              size="sm"
            >
              inactive
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
          <UButton
            icon="i-lucide-trash-2"
            size="xs"
            color="error"
            variant="ghost"
            aria-label="Delete skill"
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
            data-testid="save-skill"
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
        title="Could not load this skill"
        :description="String((loadError as { data?: { statusMessage?: string } }).data?.statusMessage ?? loadError)"
      />

      <div
        v-else
        class="flex h-full min-h-0"
      >
        <div class="flex-1 min-w-0 flex flex-col min-h-0">
          <MarkdownConfigEditor
            v-model="content"
            view-mode-cookie="mm.config.viewMode"
            default-view-mode="split"
            :readonly="!loaded"
            @save="onSave"
          >
            <template #header>
              <UIcon
                name="i-lucide-graduation-cap"
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
                title="This skill was changed elsewhere"
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
                title="Someone else saved this skill while you were editing"
                description="Your edits are kept. Saving now will report a conflict you can resolve."
                :actions="[{ label: 'Discard mine and reload', color: 'neutral', variant: 'outline', onClick: () => { void reload() } }]"
              />
            </template>
          </MarkdownConfigEditor>
        </div>

        <div class="w-80 shrink-0 border-l border-default min-h-0 hidden lg:flex flex-col">
          <ConfigRevisionsPanel
            kind="skill"
            :slug="slug"
            @reverted="reload"
          />
        </div>
      </div>

      <!-- Teleported, so its place in the tree is only to keep one template root. -->
      <UModal
        v-model:open="deleteOpen"
        :title="`Delete ${slug}?`"
        description="The skill disappears from the agent and the / menu. Its revisions are kept."
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
