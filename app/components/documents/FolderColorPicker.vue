<script setup lang="ts">
import { FOLDER_PALETTE, type FolderColorSource } from '~~/shared/types/folders'

const props = defineProps<{
  open: boolean
  folderId: string
  folderPath: string
  current: string | null
  source: FolderColorSource | null
}>()

const emit = defineEmits<{ 'update:open': [boolean] }>()

const toast = useToast()
const setColor = useSetFolderColorMutation()

/** The hex being applied, or the sentinel 'inherit' for the clear-override option; null when idle. */
const saving = ref<string | null>(null)

// `color: hex` sets an override; `color: null` clears it back to inheriting — the PATCH body
// distinguishes the two by `undefined` vs `null`, so this must always send the key, never omit it.
async function choose(hex: string | null) {
  saving.value = hex ?? 'inherit'
  try {
    await setColor.mutateAsync({ id: props.folderId, color: hex })
    // No success toast (Task 17 toast discipline): the folder's colour rail updates immediately
    // and this modal closes, both visible results.
    emit('update:open', false)
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: "Couldn't set colour", description: err.data?.statusMessage ?? err.message })
  } finally {
    saving.value = null
  }
}
</script>

<template>
  <UModal
    :open="open"
    @update:open="emit('update:open', $event)"
  >
    <template #content>
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-palette"
              class="size-5"
            />
            <span class="font-semibold">Folder colour</span>
          </div>
        </template>

        <div class="flex flex-col gap-3">
          <p class="text-sm text-muted font-mono truncate">
            {{ folderPath }}
          </p>

          <!-- The folder may already be showing a colour it doesn't own — say so, or an
               inherited swatch reads as a bug instead of the working cascade it is. -->
          <p
            v-if="source && source !== 'own'"
            class="text-xs text-dimmed"
          >
            Currently inheriting {{ source === 'project' ? 'this project’s colour' : 'the parent folder’s colour' }}.
          </p>

          <div class="flex flex-wrap items-center gap-2">
            <UButton
              color="neutral"
              variant="outline"
              class="size-8 rounded-full p-0 justify-center shrink-0"
              :class="!current ? 'ring-2 ring-primary ring-offset-2 ring-offset-default' : ''"
              :loading="saving === 'inherit'"
              :disabled="!!saving"
              aria-label="Inherit"
              @click="choose(null)"
            >
              <UIcon
                v-if="!current"
                name="i-lucide-check"
                class="size-4"
              />
              <UIcon
                v-else
                name="i-lucide-ban"
                class="size-4 text-dimmed"
              />
            </UButton>

            <UButton
              v-for="hex in FOLDER_PALETTE"
              :key="hex"
              class="size-8 rounded-full p-0 justify-center shrink-0"
              :class="current === hex ? 'ring-2 ring-primary ring-offset-2 ring-offset-default' : ''"
              :style="{ backgroundColor: hex }"
              :loading="saving === hex"
              :disabled="!!saving"
              :aria-label="hex"
              @click="choose(hex)"
            >
              <UIcon
                v-if="current === hex"
                name="i-lucide-check"
                class="size-4 text-white"
              />
            </UButton>
          </div>
        </div>

        <template #footer>
          <div class="flex justify-end">
            <UButton
              color="neutral"
              variant="ghost"
              @click="emit('update:open', false)"
            >
              Close
            </UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>
