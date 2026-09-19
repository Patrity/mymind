<!-- app/components/agent/ContextMeter.vue -->
<!-- Wraps Elements Context (cost rows patched out — no tokenlens). Renders nothing until a
     turn has reported usage; when the answering model's context window is unknown, the
     trigger degrades to a plain token count (no ring) with an explanatory tooltip instead of
     a misleading 0%. -->
<script setup lang="ts">
import type { ContextMeterData } from '~/lib/agent/context-meter'
import { Context, ContextContent, ContextContentBody, ContextContentHeader, ContextInputUsage, ContextOutputUsage, ContextTrigger } from '@/components/ai-elements/context'
import { Button } from '@/components/ui/button'
import { tokenLabel } from '~/lib/agent/render'

const props = defineProps<{ data: ContextMeterData | null }>()

const unknownWindow = computed(() => props.data != null && props.data.maxTokens == null)
const label = computed(() => tokenLabel(props.data ? { totalTokens: props.data.usedTokens } : undefined) || '0 tok')

// ContextTrigger's own default (percent + ring) only renders when we DON'T pass it a slot —
// so the unknown-window branch supplies its own trigger content. The `title`/`aria-label`
// attrs fall through Vue's normal single-root inheritance (ContextTrigger -> HoverCardTrigger
// as-child -> the real button), which is a plain native tooltip rather than nesting the full
// Tooltip primitive stack inside another trigger's as-child chain.
const UNKNOWN_WINDOW_HINT = 'Context window unknown — set it in Settings → Models'
</script>

<template>
  <Context
    v-if="data"
    :used-tokens="data.usedTokens"
    :max-tokens="data.maxTokens ?? 0"
    :model-id="data.modelDefId ?? undefined"
    data-ai-elements
  >
    <ContextTrigger
      v-if="unknownWindow"
      :title="UNKNOWN_WINDOW_HINT"
      :aria-label="UNKNOWN_WINDOW_HINT"
    >
      <Button type="button" variant="ghost" size="xs" class="font-mono text-muted-foreground">
        {{ label }}
      </Button>
    </ContextTrigger>
    <ContextTrigger v-else />
    <ContextContent>
      <!-- Unknown window: ContextContentHeader's own no-slot fallback divides by maxTokens=0
           (a fake "0%" / "X / 0" ring) — supply our own slot content instead: the used-token
           count and the same hint as the trigger, no ring/percentage. -->
      <ContextContentHeader v-if="unknownWindow">
        <div class="flex items-center justify-between gap-3 text-xs">
          <span class="text-muted-foreground">Tokens used</span>
          <span class="font-mono text-muted-foreground">{{ label }}</span>
        </div>
        <p class="text-xs text-muted-foreground">
          {{ UNKNOWN_WINDOW_HINT }}
        </p>
      </ContextContentHeader>
      <ContextContentHeader v-else />
      <ContextContentBody>
        <ContextInputUsage />
        <ContextOutputUsage />
      </ContextContentBody>
    </ContextContent>
  </Context>
</template>
