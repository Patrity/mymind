<script setup lang="ts">
// Cycle 87: inline preview under a publish_artifact / edit_artifact tool call in chat.
const props = defineProps<{ id: string; slug: string; title: string; url: string; isPublic: boolean; version: number }>()
const toast = useToast()

async function copyLink() {
  try {
    await navigator.clipboard.writeText(new URL(props.url, window.location.origin).toString())
    toast.add({ color: 'success', title: 'Link copied' })
  } catch {
    toast.add({ color: 'error', title: 'Could not copy the link' })
  }
}
</script>

<template>
  <UCard
    variant="subtle"
    class="mb-3 shrink-0"
    :ui="{ body: 'p-3 sm:p-3 flex flex-col gap-3' }"
    data-testid="artifact-chat-card"
    :data-artifact="id"
  >
    <div class="flex items-center gap-2">
      <UIcon
        name="i-lucide-app-window"
        class="size-5 shrink-0 text-primary"
      />
      <ULink
        :to="`/artifacts/${id}`"
        class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted"
      >
        {{ title }}
      </ULink>
      <UBadge
        :color="isPublic ? 'success' : 'neutral'"
        variant="subtle"
        size="sm"
        :label="isPublic ? 'Public' : 'Private'"
      />
      <UBadge
        color="neutral"
        variant="outline"
        size="sm"
        :label="`v${version}`"
      />
    </div>
    <div class="h-[360px]">
      <ArtifactsFrame
        :artifact-id="id"
        :title="title"
        :version="version"
      />
    </div>
    <div class="flex gap-2">
      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-external-link"
        label="Open"
        :to="url"
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
    </div>
  </UCard>
</template>
