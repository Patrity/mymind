<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import type { AttachmentRef } from '~~/shared/types/conversation'
import { toUIMessages } from '~/lib/agent/to-ui-messages'
import { uiMessageText } from '~/lib/agent/render'
import { contextMeterData } from '~/lib/agent/context-meter'

definePageMeta({ title: 'Agent' })

const voice = useVoice()
const route = useRoute()
const conversations = useConversations()
const queryClient = useQueryClient()

// Home's "Ask the brain" box hands the question over via ?q=, and the composer submits it
// automatically on arrival — you land in a running answer, not a filled-in box.
// Read ONCE at setup, deliberately not a computed: it must NOT go undefined when the URL
// is stripped below.
const handoffQuery = route.query.q
const initialComposerText = typeof handoffQuery === 'string' && handoffQuery.trim() ? handoffQuery : undefined

// ...but the composer is only HANDED the question once onMounted below has connected the
// WS and applied the reasoning-model override. AgentPromptInput auto-submits the instant
// it sees `initialText`, and its `{immediate: true}` watcher fires during SETUP, which is
// two problems at once:
//   1. the turn goes out before `voice.setModel()`, so `?q=` silently ran on the DEFAULT
//      chain instead of the model the picker shows (invisible in prod, fatal in dev where
//      the default chain head is down — the turn persisted the user message and no reply);
//   2. submitForm() clears `textInput`, and a clear that lands before the textarea subtree
//      has mounted never reaches the DOM (ui/textarea's useVModel(passive) proxy is seeded
//      from the pre-clear value), so the question stayed visible in the composer after
//      being sent — one stray Enter away from sending it twice.
// Handing it over after mount fixes both: the model is applied first, and the clear is an
// ordinary post-mount transition like every manual send.
const handoffText = ref<string>()

// `q` is stripped from the URL only once the handoff has actually reached the composer
// (see onMounted below) — NOT eagerly at mount. The question is auto-submitted, so leaving
// it in the address bar permanently would mean a refresh, a bookmark or a back-button
// navigation silently fires the same model call again; but stripping it BEFORE the handoff
// means anything that throws in between loses the question from the composer and the URL
// at once, with nothing left to recover it from. Late-stripping keeps the URL as the
// fallback carrier: if the handoff never happens, a reload still re-fires it.
const router = useRouter()

// Persistent preference (cookie-backed so it survives page reloads)
const speakReply = useCookie<boolean>('agent-speak', { default: () => false })

// Reasoning-model override (ephemeral, cookie-backed). Empty cookie = default chain order.
// reka-ui's USelectMenu rejects an empty-string item value, so the "Default" option uses a
// non-empty sentinel that maps back to "no override" (empty cookie / null to setModel).
// AgentPromptInput builds the item list around the same sentinel.
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
async function resume(id: string): Promise<boolean> {
  // A fork armed against the transcript being replaced does not apply to the new one.
  pendingFork.value = null
  try {
    const { conversation, messages } = await conversations.getConversation(id)
    // Build first, commit last: if loadConversation throws, the old thread must stay
    // on screen intact rather than showing the new transcript under the old row.
    const next = toUIMessages(messages)
    await voice.loadConversation(id)
    // A turn still streaming in the old thread must not write into the resumed one.
    voice.discardTurn()
    voice.messages.value = next
    voice.conversationId.value = conversation.id
    voice.conversationTitle.value = conversation.title
    return true
  } catch (e) {
    // The rail is now the primary way into a thread, so a failed load must say so rather
    // than leaving the previous transcript on screen with a new row highlighted.
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Could not open conversation', description: err?.data?.statusMessage ?? err?.message })
    return false
  } finally {
    threadsOpen.value = false
  }
}

// ---------------------------------------------------------------------------
// Branching: fork, edit, regenerate, and the ‹ n/N › pager
//
// Every tree decision is the server's. The client only ever fetches the ACTIVE path, so it
// cannot resolve a branch parent, a branch tip, or even see that a sibling exists — it moves
// the leaf through PATCH /api/conversations/:id/leaf and then re-reads.
// ---------------------------------------------------------------------------

/**
 * Re-read the thread from the server once a turn stops generating. Two things make this
 * necessary rather than merely tidy:
 *
 * 1. IDS. A live message's id is a `randomUUID` minted for the STREAM
 *    (server/lib/voice/turn-stream.ts); the row `appendMessages` writes gets its own id, and
 *    nothing reconciles the two. So every message action addresses an id the server cannot
 *    find and PATCH /leaf 404s — verified in the browser, where a regenerate on a
 *    freshly-streamed turn 404s and the identical click after a refetch succeeds.
 * 2. BRANCH DATA. Only the server can count siblings, so a client-assembled message carries no
 *    `branch`/`siblingIds` and the ‹ n/N › pager cannot render until the refetch.
 *
 * Skipped when the tail message carries a client-only marker (stopped, connection lost): those
 * exist nowhere but in this list, so re-reading would silently drop them.
 */
/** A fork armed by the branch button, applied by `sendTurn` when the next turn goes out. */
const pendingFork = ref<{ id: string, preview: string } | null>(null)

const syncPending = ref(false)
watch(busy, (now, was) => { if (was && !now) syncPending.value = true })

// Keyed on the conversation id as well as the flag, because on the FIRST turn of a new thread
// the id does not exist yet when the turn goes idle: the orchestrator emits `idle` before
// ws.ts has created the conversation. Waiting only on `busy` therefore skipped the re-read
// exactly once per thread — on its first turn, which is the likeliest moment for someone to
// try fork or regenerate, and it failed with "That message is not in this conversation".
// The id's arrival is the cue, and ws.ts now sends that frame AFTER the append so the arrival
// also means the rows are committed.
watch([syncPending, () => voice.conversationId.value], async () => {
  if (!syncPending.value || busy.value) return
  const id = voice.conversationId.value
  if (!id) return   // a new thread's id has not landed yet; this re-runs when it does
  const before = voice.messages.value
  const tail = before.at(-1)
  // Client-only markers (stopped, connection lost) exist nowhere but in this list.
  if (tail?.metadata?.interrupted || tail?.metadata?.errorText) { syncPending.value = false; return }
  syncPending.value = false
  try {
    const { messages } = await conversations.getConversation(id)
    // A new turn may have started while that was in flight — it owns the list now.
    if (busy.value || voice.conversationId.value !== id) return
    // A turn only ever APPENDS to the active path, so a shorter result means this read raced
    // the persist. Refusing it keeps the one guarantee that matters: a re-read can never hide
    // messages that are on screen. The next turn re-syncs.
    if (messages.length < before.length) return
    voice.messages.value = toUIMessages(messages)
  } catch {
    // The transcript on screen is right apart from the ids and the pager — a failed refetch
    // must not replace a correct transcript with nothing.
  }
})

/**
 * Move the thread's active leaf, then re-sync both sides from the server.
 *
 * Re-syncing is not cosmetic. The client's transcript is append-only AND the WS session holds
 * its own copy of the history, so after a leaf move both are still reading the branch that was
 * active before — the next turn would be answered against the wrong messages. `resume` refetches
 * the new active path and sends the WS a `load` frame, which the server runs under the same lock
 * a turn queues onto, so a `sendText` issued straight after is guaranteed to see the new history.
 */
async function moveLeaf(messageId: string, op?: 'fork' | 'edit'): Promise<boolean> {
  const id = voice.conversationId.value
  if (!id) return false
  try {
    await conversations.setLeaf(id, messageId, op)
  } catch (e) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: op ? 'Could not branch from here' : 'Could not switch branch', description: err?.data?.statusMessage ?? err?.message })
    return false
  }
  // The rail and the thread list read this conversation through vue-query; the leaf move
  // changed what that query returns.
  await queryClient.invalidateQueries({ queryKey: ['conversation', id] })
  return await resume(id)
}

/** The user message a reply hangs off, walking back along the ACTIVE path. */
function precedingUserMessage(messageId: string) {
  const list = voice.messages.value
  const i = list.findIndex(m => m.id === messageId)
  if (i < 0) return null
  for (let j = i - 1; j >= 0; j--) if (list[j]!.role === 'user') return list[j]!
  return null
}

/**
 * Put the leaf back after a branch move whose turn never went out.
 *
 * Without this the thread's active path ends at the branch parent, and everything below it is
 * hidden from BOTH read paths with no way back: the pager cannot offer it, because every
 * message left on the truncated path is a lone child. That is silent content hiding — the exact
 * failure this cycle exists to prevent — reached from the UI instead of from the database.
 */
async function restoreLeaf(leafId: string | undefined, what: string) {
  const id = voice.conversationId.value
  if (!leafId || !id) return
  try {
    await conversations.setLeaf(id, leafId)   // no op: descend, a no-op for a message that IS the leaf
    await resume(id)
    toast.add({ color: 'warning', title: `${what} not sent`, description: 'The thread is back where it was.' })
  } catch (e) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: `${what} not sent, and the thread could not be restored`, description: err?.data?.statusMessage ?? err?.message })
  }
}

/**
 * Move the leaf, send the turn, and put the leaf back if the turn never goes out. Shared by
 * edit and fork because the hazard is theirs jointly: between the move and the send, the thread
 * is truncated, and a send that returns false (or throws) would leave it that way.
 */
async function branchAndSend(messageId: string, op: 'fork' | 'edit', text: string, speak: boolean, attachments: AttachmentRef[], what: string): Promise<boolean> {
  // The active path ends AT the leaf, so its last message IS the leaf — captured before the
  // move, because `moveLeaf` re-reads the thread and replaces this list.
  const previousLeaf = voice.messages.value.at(-1)?.id
  // Discard first: a reply still streaming must not re-push itself into the transcript that
  // the re-sync is about to replace.
  voice.discardTurn()
  if (!await moveLeaf(messageId, op)) return false
  let sent = false
  try {
    sent = await voice.sendText(text, speak, attachments)
  } catch {
    sent = false
  }
  // The pager appears when the watcher above re-reads the thread as this turn finishes.
  if (!sent) await restoreLeaf(previousLeaf, what)
  return sent
}

/**
 * An edit is a NEW BRANCH, never a rewrite: the original question and everything it produced
 * stay reachable through the pager. The leaf goes to the edited message's PARENT, so the
 * resend lands as its sibling.
 */
async function editTurn(messageId: string, nextText: string) {
  const text = nextText.trim()
  if (!text) return
  const attachments = voice.messages.value.find(m => m.id === messageId)?.metadata?.attachments ?? []
  await branchAndSend(messageId, 'edit', text, speakReply.value, attachments, 'Edit')
}

/**
 * Regenerate a reply — as an EDIT of the question above it, with the text unchanged.
 *
 * The spec's literal rule ("hang the new reply off the reply's parent") cannot be honoured:
 * the WS turn always persists a [user, assistant] PAIR — there is no path that appends an
 * assistant message alone — so re-sending under the user message would write U → U2 → R2 and
 * duplicate the question inside the regenerated branch. Going one step further up keeps the
 * promise the spec actually made (the previous reply stays reachable) and puts the pager on
 * the question rather than on the reply, which is where chat UIs put it anyway.
 */
async function retryTurn(messageId: string) {
  const user = precedingUserMessage(messageId)
  if (!user) return
  await editTurn(user.id, uiMessageText(user))
}

/**
 * Fork ARMS the next turn; it does not move the leaf yet.
 *
 * Moving it on the click was wrong in two ways. It silently rewound the visible transcript the
 * moment you pressed the button, and — because a fork that is armed and then abandoned has no
 * failure event to react to, the user simply navigates away — it left the thread truncated for
 * good, with everything past the fork point hidden from both read paths. Deferring to send time
 * means abandoning a fork persists nothing at all.
 */
function forkFrom(messageId: string) {
  const m = voice.messages.value.find(x => x.id === messageId)
  if (!m) return
  const text = uiMessageText(m).replace(/\s+/g, ' ').trim()
  pendingFork.value = { id: messageId, preview: text.length > 60 ? text.slice(0, 59) + '…' : (text || 'this message') }
}

/**
 * The composer's send path — passed to AgentPromptInput in place of `voice.sendText`, same
 * signature. A pending fork moves the leaf HERE, immediately before the turn goes out, so the
 * fork and the message that justifies it are one action.
 */
async function sendTurn(text: string, speak = false, attachments: AttachmentRef[] = []): Promise<boolean> {
  const fork = pendingFork.value
  if (!fork) return voice.sendText(text, speak, attachments)
  pendingFork.value = null
  return branchAndSend(fork.id, 'fork', text, speak, attachments, 'Fork')
}

/**
 * ‹ / › on the pager. The sibling to switch to can only come from the server-supplied
 * `siblingIds` — nothing else on the client knows an off-path branch exists. No `op`, so the
 * server descends to that sibling's branch TIP and the branch resumes where it was left.
 */
async function switchBranch(messageId: string, dir: -1 | 1) {
  const m = voice.messages.value.find(x => x.id === messageId)
  const target = (m?.metadata?.siblingIds ?? [])[(m?.metadata?.branch?.index ?? 1) - 1 + dir]
  if (!target) return
  voice.discardTurn()
  await moveLeaf(target)
}

function startNewConversation() {
  voice.newConversation() // also clears voice.conversationId / conversationTitle
  pendingFork.value = null
  threadsOpen.value = false
}

// Auto-connect the WS on mount so the chat is usable immediately — typing and
// sending "just work" without an explicit Connect step. Resume a thread if ?c= is set.
onMounted(async () => {
  await voice.connect()
  // The registry load must NOT be able to cost the user their question. `useAiConfig().load()`
  // is a bare `$fetch` with no catch of its own, so an unreachable/500 `/api/settings/ai-config`
  // rejects here — and an async onMounted that unwinds never reaches the `?q=` handoff below.
  // The model override is a nice-to-have (the server no-ops an unknown id anyway); the handoff
  // is the whole reason the user is on this page.
  try {
    await loadAiConfig()
    // Drop a stale override: if the cookie names a model no longer assigned to
    // reasoning, clear it so the dropdown doesn't show a blank label and no dead
    // id is sent. (Server reorderChain already no-ops an unknown id, so this is
    // cosmetic — but keeps the picker honest.) Only meaningful when the registry
    // really loaded: an empty draft from a FAILED load would clear a good cookie.
    if (agentModel.value && !(aiDraft.value.assignments.reasoning ?? []).includes(agentModel.value)) {
      agentModel.value = ''
    }
  } catch (e) {
    console.warn('[agent] could not load the model registry; keeping the stored model override', e)
  }
  if (agentModel.value) voice.setModel(agentModel.value)
  const c = route.query.c
  if (typeof c === 'string' && c) await resume(c) // never throws — it has its own try/catch
  // Only now hand `?q=` to the composer — see the comment on handoffText.
  handoffText.value = initialComposerText
  // ...and only now drop `q` from the address bar, once the composer actually has it.
  if (initialComposerText) void router.replace({ path: route.path, query: { ...route.query, q: undefined } })
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
      <!-- overflow-hidden: the clipping wrapper for the full Persona. It's sized by `flex-1
           min-h-0` (whatever the toolbar-less overlay leaves after the caption + mic band),
           and the Persona itself is capped to fit THAT (size="full" in Persona.client.vue), so on a short
           viewport (a landscape phone, a small window) it shrinks instead of pushing the mic
           band off-screen the way a fixed size-72/sm:size-96 did. -->
      <div class="flex flex-1 min-h-0 items-center justify-center overflow-hidden">
        <AgentPersona
          size="full"
          :state="voice.state.value"
          :connected="voice.connected.value"
        />
      </div>
      <!-- Capped + internally scrollable: the persona now shrinks to fit its wrapper
           (max-h-72/sm:max-h-96, aspect-square — Persona.client.vue) rather than holding a
           fixed size, and the mic band is shrink-0, so an uncapped caption is the only
           flexible thing left — on a long reply at a short viewport (375x700, the phone case
           this mode is likeliest to hit) it grew past the fold and pushed the mic band below
           y=700 with no way to scroll to it. Capping keeps both always on-screen; a long line
           scrolls internally instead of displacing them. -->
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
            <AgentSettingsSlideover
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
          :hero="!fullBleed"
          @undo="undoTool"
          @retry="retryTurn"
          @edit="editTurn"
          @fork="forkFrom"
          @branch="switchBranch"
          @pick="pickStarter"
          @approve="(id, o) => voice.sendApproval(id, true, o)"
          @deny="id => voice.sendApproval(id, false)"
        />
        <!-- !fullBleed: the overlay above mounts its OWN AgentMicBand (~line 260) — without
             this guard, turning the mic on while voice mode is open ran two bands (and two
             analyser-driven RAF loops) at once, one hidden behind the other. -->
        <AgentMicBand
          v-if="micOn && !fullBleed"
          :mic-analyser="voice.micAnalyser()"
          :speech-prob="voice.speechProb.value"
          :active="micOn"
        />
        <!-- A fork is ARMED, not applied, until the next turn is sent: abandoning it must
             persist nothing and must not rewind the transcript. So the pending state needs to
             be visible, and cancellable. -->
        <UAlert
          v-if="pendingFork"
          icon="i-lucide-git-branch"
          color="primary"
          variant="subtle"
          class="rounded-none"
          :title="`Your next message branches from “${pendingFork.preview}”`"
        >
          <template #actions>
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              label="Cancel"
              aria-label="Cancel fork"
              @click="pendingFork = null"
            />
          </template>
        </UAlert>
        <AgentPromptInput
          v-model:speak="speakReply"
          v-model:model="selectedModel"
          :send-text="sendTurn"
          :busy="busy"
          :mic-on="micOn"
          :state="voice.state.value"
          :connected="voice.connected.value"
          :show-persona="voice.messages.value.length > 0 && !fullBleed"
          :context-meter="contextMeter"
          :initial-text="handoffText"
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
