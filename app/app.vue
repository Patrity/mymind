<script setup lang="ts">
useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' }
  ],
  htmlAttrs: {
    lang: 'en'
  }
})

useSeoMeta({
  title: 'MyMind',
  description: 'Personal document management, memories, and project tracking.'
})
</script>

<template>
  <!-- delayDuration: 0 — tooltips are used here to carry real information (rig service
       identity, per-project stat meanings), not decorative hints, so the default hover
       delay just makes the data feel unreachable. Applies app-wide via TooltipProvider. -->
  <UApp :tooltip="{ delayDuration: 0 }">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
