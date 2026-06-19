<!-- app/components/agent/ApprovalPrompt.vue -->
<script setup lang="ts">
const props = defineProps<{ approval: { requestId: string; tool: string; command: string; proposedPattern: string } }>()
const emit = defineEmits<{ approve: [{ remember: boolean; pattern: string }]; deny: [] }>()

const remember = ref(false)
const pattern = ref(props.approval.proposedPattern)
watch(() => props.approval, (a) => { remember.value = false; pattern.value = a.proposedPattern })

function approve() {
  emit('approve', { remember: remember.value, pattern: pattern.value })
}
function deny() {
  emit('deny')
}
</script>

<template>
  <div class="rounded-lg border border-warning bg-warning/10 p-4 flex flex-col gap-3">
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-shield-alert" class="text-warning size-5" />
      <span class="text-sm font-semibold text-highlighted">Approve <code>{{ approval.tool }}</code> command?</span>
    </div>
    <pre class="bg-elevated/60 rounded p-2 text-xs font-mono whitespace-pre-wrap break-all">{{ approval.command }}</pre>
    <div class="flex items-center gap-2">
      <UCheckbox v-model="remember" />
      <span class="text-sm text-muted">Always allow commands matching</span>
      <UInput v-model="pattern" :disabled="!remember" size="xs" class="font-mono flex-1 max-w-xs" />
    </div>
    <div class="flex items-center gap-2">
      <UButton label="Approve" color="primary" icon="i-lucide-check" @click="approve()" />
      <UButton label="Deny" color="neutral" variant="soft" icon="i-lucide-x" @click="deny()" />
    </div>
  </div>
</template>
