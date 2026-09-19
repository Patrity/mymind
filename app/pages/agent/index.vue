<script setup lang="ts">
import { toUIMessages } from '~/lib/agent/to-ui-messages'
import { uiMessageText } from '~/lib/agent/render'
import { truncateForRetry } from '~/lib/agent/retry'
import { contextMeterData } from '~/lib/agent/context-meter'

definePageMeta({ title: 'Agent' })

const voice = useVoice()
const route = useRoute()

// Home's "Ask the brain" box hands the question over via ?q=, and the composer submits it
// automatically on arrival — you land in a running answer, not a filled-in box.
// Read ONCE at setup, deliberately not a computed: the composer must receive it on its
// first mount, and it must NOT go undefined when the URL is stripped below.
const handoffQuery = route.query.q
const initialComposerText = typeof handoffQuery === 'string' && handoffQuery.trim() ? handoffQuery : undefined

// Strip `q` from the URL as soon as we've captured it. The question is auto-submitted, so
// leaving it in the address bar would mean a refresh, a bookmark, or a back-button
// navigation silently fires the same model call again.
const router = useRouter()
onMounted(() => {
  if (!initialComposerText) return
  void router.replace({ path: route.path, query: { ...route.query, q: undefined } })
})

// Persistent preference (cookie-backed so it survives page reloads)
const speakReply = useCookie<boolean>('agent-speak', { default: () => false })

// Reasoning-model override (ephemeral, cookie-backed). Empty cookie = default chain order.
// reka-ui's USelectMenu rejects an empty-string item value, so the "Default" option uses a
// non-empty sentinel that maps back to "no override" (empty cookie / null to setModel).
// AgentToolbar builds the item list around the same sentinel.
const DEFAULT_MODEL = '__default__'
const { load: loadAiConfig, draft: aiDraft } = useAiConfig()
const agentModel = useCookie<string>('agent-model', { default: () => '' })
const selectedModel = computed({
  get: () => agentModel.value || DEFAULT_MODEL,
  set: (val: string) => {
    const id = val === DEFAULT_MODEL ? '' : val
    agentModel.value = id
    voice.setModel(id || null)
  }
})

// Mic-on state is local — it reflects whether the VAD is actually running
const micOn = ref(false)

// Empty-state starter click -> composer prefill. A page-local ref rather than plumbing
// through useVoice: it's pure UI state, gone the moment the first message lands (the
// empty state that produced it is v-if'd away by then).
const starterPrefill = ref<string>()
function pickStarter(prompt: string) {
  starterPrefill.value = prompt
}

// Which thread the conversation column is showing lives in useVoice, because the
// SERVER is what decides it: a brand-new thread is created lazily on the first turn
// and its id + derived title come back over the WS. Mirroring that into page-local
// refs would have meant the toolbar and rail only learned about a new thread on a
// reload.

// Thread rail as a slideover — the only way to reach threads under lg, where the rail
// column is hidden.
const threadsOpen = ref(false)

// Full-bleed voice mode (the overlay itself lands with the avatar work).
const fullBleed = ref(false)

// The context meter's data: the latest assistant message's usage against the
// answering model's context window, falling back to the selected override / the
// reasoning chain head when the message's own usage didn't carry a modelDefId.
const contextMeter = computed(() => contextMeterData(
  voice.messages.value,
  aiDraft.value.models,
  [agentModel.value || null, aiDraft.value.assignments.reasoning?.[0]]
))

// True while a turn is generating (LLM output, a tool call, or TTS playback) — drives
// the composer's Stop button. 'listening'/'connecting' are client-only states, not
// generation, so they're deliberately excluded.
const busy = computed(() => ['thinking', 'tool', 'speaking', 'typing'].includes(voice.state.value))

// Caption over the avatar: the message currently being spoken/typed. Consumed by
// full-bleed mode.
const caption = computed(() => {
  const list = voice.messages.value
  for (let i = list.length - 1; i >= 0; i--) {
    const text = uiMessageText(list[i]!)
    if (text) return { id: list[i]!.id, text }
  }
  return null
})

// Tool calls undone this session (by toolCallId). Resumed tool parts start not-undone,
// exactly as the old chips did.
const toast = useToast()
const redeem = useUndo()
const undone = reactive(new Set<string>())
async function undoTool(toolCallId: string, undoToken: string) {
  try {
    const { ok } = await redeem(undoToken)
    if (ok) undone.add(toolCallId)
  } catch (e) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Undo failed', description: err?.data?.statusMessage ?? err?.message })
  }
}

async function toggleMic() {
  if (micOn.value) {
    await voice.disableMic()
    micOn.value = false
  } else {
    await voice.connect() // ensure the WS is up before requesting the mic
    // enableMic() swallows a denied/missing mic into voice.error rather than throwing —
    // only flip to "on" when it actually started, or a phone with a denied mic shows
    // "Disable microphone" and a lit-up band over a mic that never ran.
    micOn.value = await voice.enableMic()
  }
}

// Persisted messages -> AgentUIMessage[] (chip placement, legacy fallback, trailing-bubble
// rule) lives in ~/lib/agent/to-ui-messages so it can be unit-tested.
async function resume(id: string) {
  try {
    const { conversation, messages } = await useConversations().getConversation(id)
    // Build first, commit last: if loadConversation throws, the old thread must stay
    // on screen intact rather than showing the new transcript under the old row.
    const next = toUIMessages(messages)
    await voice.loadConversation(id)
    // A turn still streaming in the old thread must not write into the resumed one.
    voice.discardTurn()
    voice.messages.value = next
    voice.conversationId.value = conversation.id
    voice.conversationTitle.value = conversation.title
  } catch (e) {
    // The rail is now the primary way into a thread, so a failed load must say so rather
    // than leaving the previous transcript on screen with a new row highlighted.
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Could not open conversation', description: err?.data?.statusMessage ?? err?.message })
  } finally {
    threadsOpen.value = false
  }
}

/** Re-send the user turn that preceded this assistant message, dropping the assistant
 *  turn and everything after it. This replaces in place — it does NOT fork; parent_id
 *  branching stays deferred. Pure walk-back-and-truncate logic lives in
 *  ~/lib/agent/retry so it's unit-testable without a live voice connection. */
async function retryTurn(messageId: string) {
  const plan = truncateForRetry(voice.messages.value, messageId)
  if (!plan) return
  // Retrying a reply that is still streaming: its turn would otherwise re-push the message
  // this truncation just removed.
  voice.discardTurn()
  voice.messages.value = plan.messages
  await voice.sendText(plan.text, speakReply.value, plan.attachments)
}

function startNewConversation() {
  voice.newConversation() // also clears voice.conversationId / conversationTitle
  threadsOpen.value = false
}

// Auto-connect the WS on mount so the chat is usable immediately — typing and
// sending "just work" without an explicit Connect step. Resume a thread if ?c= is set.
onMounted(async () => {
  await voice.connect()
  await loadAiConfig()
  // Drop a stale override: if the cookie names a model no longer assigned to
  // reasoning, clear it so the dropdown doesn't show a blank label and no dead
  // id is sent. (Server reorderChain already no-ops an unknown id, so this is
  // cosmetic — but keeps the picker honest.)
  if (agentModel.value && !(aiDraft.value.assignments.reasoning ?? []).includes(agentModel.value)) {
    agentModel.value = ''
  }
  if (agentModel.value) voice.setModel(agentModel.value)
  const c = route.query.c
  if (typeof c === 'string' && c) await resume(c)
})

// Full-bleed's Escape must work even when focus never lands inside the overlay (e.g. the
// user tabbed to the close button, or focus is still on the toolbar trigger that opened
// it) — a listener scoped to the overlay div alone would miss those. Setting fullBleed to
// false when it is already false is a no-op, so this never interferes with typing (Escape
// included) in the composer while full-bleed is closed.
onMounted(() => {
  const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') fullBleed.value = false }
  window.addEventListener('keydown', onEsc)
  onBeforeUnmount(() => window.removeEventListener('keydown', onEsc))
})
</script>

<template>
  <!-- Two columns: threads / conversation. Resizable panels don't have a single root
       element — wrap them in a flex container.

       Under lg the threads column collapses and the conversation takes the full width —
       that is the fix for the page having had no usable composer below 1024px. -->
  <div class="flex flex-1 min-w-0 h-full">
    <!-- Mic/voice errors (e.g. a denied microphone permission): rendered fixed at the
         page root so they're visible at every viewport width and in full-bleed mode.
         z-[60] sits above full-bleed's z-50 overlay.
         pointer-events-none: it carries no close/action button, so it must not sit in
         front of the toolbar buttons underneath it and eat their clicks. -->
    <UAlert
      v-if="voice.error.value"
      color="error"
      class="pointer-events-none fixed inset-x-3 top-3 z-[60] sm:inset-x-auto sm:right-3 sm:max-w-sm"
      :title="voice.error.value"
    />

    <!-- Full-bleed voice mode: her, the band, and the current line, with the two-column
         chrome kept mounted underneath (just covered) so the conversation's scroll position
         survives the round trip. The caption goes through MdView, never raw interpolation —
         the old page printed `{{ caption.text }}` as plain text, so the most prominent text
         on the screen showed literal `#`/`**`, the visible twin of the TTS-pronounces-
         asterisks bug. cache-key is per-message: a shared first delta otherwise collides on
         MDC's hash-of-value key and renders another message's content. -->
    <div
      v-if="fullBleed"
      class="fixed inset-0 z-50 flex flex-col bg-elevated"
      role="dialog"
      aria-label="Voice mode"
      @keydown.esc="fullBleed = false"
    >
      <UButton
        icon="i-lucide-minimize-2"
        variant="ghost"
        color="neutral"
        class="absolute right-4 top-4 z-10"
        aria-label="Back to chat"
        @click="fullBleed = false"
      />
      <div class="flex flex-1 min-h-0 items-center justify-center">
        <AgentPersona
          size="full"
          :state="voice.state.value"
          :connected="voice.connected.value"
        />
      </div>
      <!-- Capped + internally scrollable: the persona has its own min-height floor
           (Persona.client.vue) and the mic band is shrink-0, so an uncapped caption is the
           only flexible thing left — on a long reply at a short viewport (375x700, the
           phone case this mode is likeliest to hit) it grew past the fold and pushed the
           mic band below y=700 with no way to scroll to it. Capping keeps both always
           on-screen; a long line scrolls internally instead of displacing them. -->
      <div
        v-if="caption"
        class="mx-auto mb-4 max-h-40 max-w-2xl shrink-0 overflow-y-auto px-6 text-center"
      >
        <MdView
          :source="caption.text"
          :cache-key="`caption-${caption.id}`"
          class="text-sm text-highlighted"
        />
      </div>
      <AgentMicBand
        :mic-analyser="voice.micAnalyser()"
        :speech-prob="voice.speechProb.value"
        :active="micOn"
      />
    </div>

    <UDashboardPanel
      id="agent-threads"
      resizable
      :default-size="14"
      :min-size="10"
      :max-size="24"
      class="hidden lg:flex"
      :ui="{ body: '!p-0 !gap-0' }"
    >
      <template #body>
        <AgentThreadRail
          :active-id="voice.conversationId.value"
          @select="resume"
          @new="startNewConversation"
        />
      </template>
    </UDashboardPanel>

    <!-- `grow`: the conversation column is the fluid remainder to the right of the
         (fixed-width) threads rail. -->
    <UDashboardPanel
      id="agent-conversation"
      resizable
      :default-size="58"
      :min-size="35"
      :max-size="80"
      class="grow"
      :ui="{ body: '!p-0 !gap-0' }"
    >
      <template #header>
        <AgentToolbar
          :title="voice.conversationTitle.value"
          @threads="threadsOpen = true"
          @full-bleed="fullBleed = true"
        >
          <template #actions>
            <VoiceSettingsSlideover
              v-model:speak="speakReply"
              :voice="voice"
            />
          </template>
        </AgentToolbar>
      </template>

      <template #body>
        <AgentConversation
          class="flex-1 min-h-0"
          :messages="voice.messages.value"
          :undone="undone"
          :approval="voice.pendingApproval.value"
          :state="voice.state.value"
          :connected="voice.connected.value"
          @undo="undoTool"
          @retry="retryTurn"
          @pick="pickStarter"
          @approve="(id, o) => voice.sendApproval(id, true, o)"
          @deny="id => voice.sendApproval(id, false)"
        />
        <AgentMicBand
          v-if="micOn"
          :mic-analyser="voice.micAnalyser()"
          :speech-prob="voice.speechProb.value"
          :active="micOn"
        />
        <AgentPromptInput
          v-model:speak="speakReply"
          v-model:model="selectedModel"
          :send-text="voice.sendText"
          :busy="busy"
          :mic-on="micOn"
          :state="voice.state.value"
          :connected="voice.connected.value"
          :show-persona="voice.messages.value.length > 0 && !fullBleed"
          :context-meter="contextMeter"
          :initial-text="initialComposerText"
          :auto-send="!!initialComposerText"
          :prefill="starterPrefill"
          @stop="voice.stop"
          @toggle-mic="toggleMic"
        />
      </template>
    </UDashboardPanel>

    <!-- Threads under lg, where the rail column is hidden. -->
    <USlideover
      v-model:open="threadsOpen"
      side="left"
      title="Conversations"
      description="Pick a thread to resume it."
      :ui="{ body: '!p-0' }"
    >
      <template #body>
        <AgentThreadRail
          :active-id="voice.conversationId.value"
          @select="resume"
          @new="startNewConversation"
        />
      </template>
    </USlideover>
  </div>
</template>
