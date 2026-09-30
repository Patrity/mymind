<script setup lang="ts">
/**
 * Settings → Profile (cycle 76) — the "About Tony" profile Bridget reads in her prompt. Same
 * editor, explicit save (button / ⌘S, via useConfigSource's CAS write) and revision history as
 * /skills/[slug] and /jobs/[slug]; the profile is a singleton, so its "slug" is fixed.
 *
 * Renders its own UDashboardPanel (settingsPanel: false) because the editor needs the full
 * height, which app/pages/settings.vue's padded, scrolling body cannot give it.
 */
import { profileStarterMarkdown } from '~/lib/config/profile-starter'

definePageMeta({ title: 'Profile', settingsPanel: false })

interface ProfileSourceResponse { content: string, contentHash: string, tokens: number, budget: number, overBudget: boolean }

const SLUG = 'profile'
const toast = useToast()

const {
  raw, content, dirty, saving, error, conflict, changedElsewhere, loaded, loadError,
  save, discardToServer, overwrite, reload
} = useConfigSource('profile', SLUG)

const serverCopy = computed(() => raw.value as ProfileSourceResponse | undefined)

useHead({ title: 'Profile · Settings' })

// An empty profile opens on the starter template. It only fills the editor (the page is then
// dirty, so Save writes it); nothing is stored until Tony saves. Keyed on the server copy, not on
// `content`, so clearing the editor by hand never re-inserts it.
const starter = profileStarterMarkdown()
watch(() => [loaded.value, serverCopy.value?.contentHash] as const, ([isLoaded]) => {
  if (isLoaded && !dirty.value && content.value === '') content.value = starter
}, { immediate: true })
// The untouched starter is not an edit worth guarding a navigation for.
const edited = computed(() => dirty.value && content.value !== starter)

// The same estimate the prompt uses (server/lib/agent/profile-budget.ts: ceil(chars / 4)),
// computed from the editor so the meter follows typing rather than the last save.
const budget = computed(() => serverCopy.value?.budget ?? 1500)
const tokens = computed(() => Math.ceil(content.value.length / 4))
const overBudget = computed(() => tokens.value > budget.value)

async function onSave() {
  if (!dirty.value) return
  if (await save()) toast.add({ color: 'success', title: 'Profile saved' })
}

async function onOverwrite() {
  if (await overwrite()) toast.add({ color: 'success', title: 'Profile saved', description: 'Overwrote the other version' })
}

// Leaving with unsaved edits: the in-app route guard and the tab-close guard.
onBeforeRouteLeave(() => {
  if (edited.value && !window.confirm('Discard unsaved changes to your profile?')) return false
})
useEventListener('beforeunload', (e: BeforeUnloadEvent) => {
  if (edited.value) e.preventDefault()
})
</script>

<template>
  <UDashboardPanel
    id="settings-profile"
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
            <span class="text-muted">Settings</span>
            <UIcon
              name="i-lucide-chevron-right"
              class="size-4 text-dimmed shrink-0"
            />
            <span class="truncate text-highlighted">Profile</span>
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
          <div
            v-if="loaded"
            class="flex items-center gap-2"
            data-testid="profile-token-meter"
          >
            <UProgress
              :model-value="Math.min(tokens, budget)"
              :max="budget"
              :color="overBudget ? 'warning' : 'primary'"
              size="sm"
              class="w-28"
            />
            <span
              class="text-xs tabular-nums"
              :class="overBudget ? 'text-warning' : 'text-muted'"
            >{{ tokens }} / {{ budget }}</span>
          </div>
          <UButton
            icon="i-lucide-save"
            size="xs"
            color="primary"
            label="Save"
            :loading="saving"
            :disabled="!dirty"
            data-testid="save-profile"
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
        title="Could not load your profile"
        :description="String((loadError as { data?: { statusMessage?: string } }).data?.statusMessage ?? loadError)"
      />

      <div
        v-else
        class="flex h-full min-h-0"
      >
        <div class="flex-1 min-w-0 flex flex-col min-h-0">
          <!-- Mounted only once the source is loaded — see /skills/[slug] for why (CodeMirror
               never attaches when the editor mounts during the initial Suspense render). -->
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
                name="i-lucide-user-round"
                class="size-4 text-dimmed shrink-0"
              />
              <span class="text-xs text-muted truncate">About Tony — read by Bridget in every conversation</span>
            </template>

            <template #banner>
              <UAlert
                v-if="overBudget"
                class="rounded-none"
                color="warning"
                variant="subtle"
                icon="i-lucide-scissors"
                title="Only the first 1,500 tokens are used in Bridget's prompt"
                data-testid="profile-over-budget"
              />
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
                title="Your profile was changed elsewhere"
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
                title="Your profile was saved elsewhere while you were editing"
                description="Your edits are kept. Saving now will report a conflict you can resolve."
                :actions="[{ label: 'Discard mine and reload', color: 'neutral', variant: 'outline', onClick: () => { void reload() } }]"
              />
            </template>
          </MarkdownConfigEditor>
        </div>

        <div class="w-80 shrink-0 border-l border-default min-h-0 hidden lg:flex flex-col">
          <ConfigRevisionsPanel
            kind="profile"
            :slug="SLUG"
            :dirty="dirty"
            @reverted="reload"
          />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
