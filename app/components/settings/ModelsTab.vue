<!-- app/components/settings/ModelsTab.vue -->
<!--
  Models list for the AI config registry. Edits mutate the shared draft in
  place (ModelForm receives the same object), so opening/closing the form needs
  no write-back. Save PUTs the whole doc; the server validates strictly.
-->
<script setup lang="ts">
import type { DraftModel } from '~/composables/useAiConfig'

const config = useAiConfig()

onMounted(() => config.load())

const open = ref(false)
const editing = ref<DraftModel | null>(null)

function providerName(providerId: string): string {
  return config.draft.value.providers.find(p => p.id === providerId)?.name ?? '—'
}

function edit(m: DraftModel) {
  editing.value = m
  open.value = true
}

function add() {
  edit(config.addModel())
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-base font-semibold text-highlighted">
          Models
        </h2>
        <p class="text-sm text-muted">
          Models exposed by your providers.
        </p>
      </div>
      <UButton
        label="Add model"
        icon="i-lucide-plus"
        color="neutral"
        variant="subtle"
        @click="add"
      />
    </div>

    <p
      v-if="config.draft.value.models.length === 0"
      class="rounded-lg border border-dashed border-default p-6 text-center text-sm text-muted"
    >
      No models yet. Add one to get started.
    </p>

    <UCard
      v-for="m in config.draft.value.models"
      :key="m.id"
      variant="subtle"
    >
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <span class="font-medium text-highlighted">{{ m.label }}</span>
            <UBadge
              v-if="m.dim !== null"
              :label="`dim ${m.dim}`"
              color="neutral"
              variant="subtle"
              size="sm"
            />
          </div>
          <span class="text-sm text-muted">{{ m.modelId || '—' }}</span>
          <UBadge
            :label="providerName(m.providerId)"
            color="neutral"
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
            aria-label="Edit model"
            @click="edit(m)"
          />
          <UButton
            icon="i-lucide-trash-2"
            color="error"
            variant="ghost"
            aria-label="Delete model"
            @click="config.removeModel(m.id)"
          />
        </div>
      </div>
    </UCard>

    <SettingsModelForm
      v-if="editing"
      v-model:open="open"
      :model="editing"
      :providers="config.draft.value.providers"
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
