<!-- app/pages/voice.vue -->
<!-- The voice studio moved to Settings → Voice (cycle 76). Old links and bookmarks land there. -->
<script setup lang="ts">
definePageMeta({
  middleware: () => navigateTo('/settings/voice', { redirectCode: 301 })
})
</script>

<template>
  <div />
</template>
