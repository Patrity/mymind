<script setup lang="ts">
// Cycle 86: the sandboxed view of a published artifact. The sandbox deliberately omits
// allow-same-origin: artifact JS runs in an opaque origin and can never touch MyMind's session.
import { ARTIFACT_SANDBOX } from '~/lib/artifacts/display'

// `version` is only a remount key: a new current version (rollback, agent republish) reloads the iframe.
const props = defineProps<{ artifactId: string; title?: string; version?: number | null }>()
const { data, isPending, error } = useArtifactViewUrl(computed(() => props.artifactId))
</script>

<template>
  <div
    class="relative h-full min-h-40 w-full overflow-hidden rounded-md border border-default bg-default"
    data-testid="artifact-frame"
  >
    <USkeleton
      v-if="isPending"
      class="size-full"
    />
    <p
      v-else-if="error || !data?.url"
      class="p-4 text-sm text-error"
    >
      Could not load this artifact.
    </p>
    <iframe
      v-else
      :key="`${data.url}@${version ?? 0}`"
      :src="data.url"
      :title="title ?? 'Artifact'"
      :sandbox="ARTIFACT_SANDBOX"
      referrerpolicy="no-referrer"
      loading="lazy"
      class="size-full border-0 bg-white"
    />
  </div>
</template>
