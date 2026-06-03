<script setup lang="ts">
// No props — just a styled note box with a slot.
</script>

<template>
  <div class="my-3 rounded-lg border border-default bg-elevated/40 px-4 py-3 text-sm leading-relaxed text-muted">
    <slot />
  </div>
</template>
