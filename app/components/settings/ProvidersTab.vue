<!-- app/components/settings/ProvidersTab.vue -->
<!--
  Providers list for the AI config registry. Edits mutate the shared draft in
  place (ProviderForm receives the same object), so opening/closing the form
  needs no write-back. Save PUTs the whole doc; the server validates strictly.
-->
<script setup lang="ts">
import type { DraftProvider } from '~/composables/useAiConfig'

const config = useAiConfig()

onMounted(() => config.load())

const open = ref(false)
const editing = ref<DraftProvider | null>(null)

function edit(p: DraftProvider) {
  editing.value = p
  open.value = true
}

function add() {
  edit(config.addProvider())
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-base font-semibold text-highlighted">
          Providers
        </h2>
        <p class="text-sm text-muted">
          AI services MyMind can connect to.
        </p>
      </div>
      <UButton
        label="Add provider"
        icon="i-lucide-plus"
        color="neutral"
        variant="subtle"
        @click="add"
      />
    </div>

    <p
      v-if="config.draft.value.providers.length === 0"
      class="rounded-lg border border-dashed border-default p-6 text-center text-sm text-muted"
    >
      No providers yet. Add one to get started.
    </p>

    <UCard
      v-for="p in config.draft.value.providers"
      :key="p.id"
      variant="subtle"
    >
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <span class="font-medium text-highlighted">{{ p.name }}</span>
            <UBadge
              :label="p.kind"
              color="neutral"
              variant="subtle"
              size="sm"
            />
          </div>
          <span
            v-if="p.baseURL"
            class="text-sm text-muted"
          >{{ p.baseURL }}</span>
          <UBadge
            :label="p.hasKey ? 'key set' : 'no key'"
            :color="p.hasKey ? 'success' : 'neutral'"
            variant="soft"
            size="sm"
            class="self-start"
          />
        </div>
        <div class="flex items-center gap-2">
          <UButton
            icon="i-lucide-pencil"
            color="neutral"
            variant="ghost"
            aria-label="Edit provider"
            @click="edit(p)"
          />
          <UButton
            icon="i-lucide-trash-2"
            color="error"
            variant="ghost"
            aria-label="Delete provider"
            @click="config.removeProvider(p.id)"
          />
        </div>
      </div>
    </UCard>

    <SettingsProviderForm
      v-if="editing"
      v-model:open="open"
      :provider="editing"
      :on-test="config.testProvider"
      @close="editing = null"
    />

    <div class="flex items-center gap-3 border-t border-default pt-4">
      <UButton
        label="Save"
        color="primary"
        :loading="config.saving.value"
        @click="config.save()"
      />
      <UAlert
        v-if="config.error.value"
        color="error"
        icon="i-lucide-alert-circle"
        :title="config.error.value"
        class="flex-1"
      />
    </div>
  </div>
</template>
