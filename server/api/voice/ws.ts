// server/api/voice/ws.ts
import { handleUtterance, handleTurn, type VoiceEvent } from '../../lib/voice/orchestrator'
import { classifyFrame } from '../../lib/voice/frames'
import { sttFromModel } from '../../lib/voice/providers'
import type { SttProvider, TtsProvider } from '../../lib/voice/providers/types'
import { ttsSynth } from '../../lib/voice/tts-failover'
import { withFailover } from '../../lib/ai/registry/resolve'
import { messageText } from '../../lib/agent/run'
import type { AgentMessage } from '../../lib/agent/run'
import { createConversation, appendMessages, getAgentHistory, deriveTitle } from '../../services/conversations'
import { buildLiveContext, buildMemoryContext } from '../../lib/agent/context'
import { publishChange } from '../../utils/live-bus'
import type { ApprovalRequest } from '../../lib/agent/types'
import { loadApprovals, addApproval, touchApproval, matchesApproval, approvalOutcome } from '../../lib/exec/approvals'
import { recordEvent } from '../../lib/observability/record'
import { randomUUID } from 'node:crypto'
import { withoutAttachmentMarkers, type AttachmentRef } from '../../lib/agent/attachments'

// Client→server: binary frame = one WAV utterance | text JSON {type:'interrupt'} |
//   {type:'voice',voice} | {type:'model',modelDefId} (ephemeral reasoning-model override; null clears) |
//   {type:'text',text,speak?} (typed turn, injected post-STT) |
//   {type:'load',conversationId} (load existing conversation) | {type:'new'} (reset) |
//   {type:'approve'|'deny',requestId,...} (resolve a pending exec approval)
// Server→client: binary = audio bytes | text JSON = transcript/reasoning/tool/state/error events.
interface ConnState {
  history: AgentMessage[]
  ac: AbortController | null
  voice: string
  /** Label of the TTS model that owns `voice` (client sends it with the pick); null = registry order. */
  ttsProvider: string | null
  model: string | null
  lock: Promise<void>
  conversationId: string | null
  pendingApprovals: Map<string, { resolve: (d: { approved: boolean }) => void; timer: ReturnType<typeof setTimeout>; req: ApprovalRequest }>
}
const conns = new WeakMap<object, ConnState>()

// STT/TTS resolved from the registry at call time, with per-usage failover.
const stt: SttProvider = {
  transcribe: (audio, opts) =>
    withFailover('stt', m => sttFromModel(m).transcribe(audio, opts))
}
// TTS: registry chain pinned to the provider that owns the chosen voice, then failover
// (see lib/voice/tts-failover.ts — the picker mixes every provider's voices, so dialing
// the chain head with another provider's voice name is a guaranteed 400 → failover).
const tts: TtsProvider = { synthesize: ttsSynth }

export default defineWebSocketHandler({
  // Server middleware does NOT run for WS upgrades (crossws handles them directly),
  // so the session must be validated here — this socket drives the full agent.
  // Returning a non-ok Response makes crossws reject the upgrade.
  async upgrade(request) {
    const session = await useAuth().api.getSession({ headers: request.headers as Headers }).catch(() => null)
    if (!session?.user) return new Response('Unauthorized', { status: 401 })
  },
  open(peer) {
    conns.set(peer, { history: [], ac: null, voice: '', ttsProvider: null, model: null, lock: Promise.resolve(), conversationId: null, pendingApprovals: new Map() })
  },
  message(peer, message) {
    const s = conns.get(peer); if (!s) return
    // Classify by CONTENT, not transport type: crossws@0.3.5's node adapter drops
    // the isBinary flag, so JSON control frames arrive as Buffers (see frames.ts).
    const frame = classifyFrame(typeof message.rawData === 'string' ? message.rawData : message.uint8Array())
    if (frame.kind === 'ignore') return
    // A turn closure reads s.history at EXECUTION time (under the lock), so
    // back-to-back turns see each other's appended messages.
    let turn: ((signal: AbortSignal, emit: (e: VoiceEvent) => void, context: string | undefined) => Promise<AgentMessage[]>) | null = null
    let inputModality: 'text' | 'voice' = 'text'
    let speakFlag = false
    let turnAttachments: AttachmentRef[] = []
    // Approval channel for dangerous tools: allowlist check → run; else emit an
    // approval request to the peer and await Tony's decision (120s auto-deny).
    // Computed unconditionally so both text + audio turn branches can reference them.
    const requestApproval = async (req: ApprovalRequest): Promise<{ approved: boolean }> => {
      const patterns = (await loadApprovals(req.tool)).filter(p => matchesApproval(req.command, [p.pattern]))
      if (patterns.length) {
        touchApproval(patterns[0]!.id).catch(() => {})
        recordEvent({ kind: 'tool', name: 'exec:approval', severity: 'info', meta: { outcome: 'allowlisted', command: req.command, pattern: patterns[0]!.pattern } })
        return { approved: true }
      }
      const requestId = randomUUID()
      return await new Promise<{ approved: boolean }>((resolve) => {
        const timer = setTimeout(() => {
          if (s.pendingApprovals.delete(requestId)) {
            recordEvent({ kind: 'tool', name: 'exec:approval', severity: 'warn', meta: { outcome: 'timeout', command: req.command } })
            peer.send(JSON.stringify({ type: 'approval-resolved', requestId }))
            resolve({ approved: false })
          }
        }, Number(process.env.APPROVAL_TIMEOUT_MS ?? 120_000))
        s.pendingApprovals.set(requestId, { resolve, timer, req })
        peer.send(JSON.stringify({ type: 'approval', requestId, tool: req.tool, command: req.command, proposedPattern: req.proposedPattern }))
      })
    }
    if (frame.kind === 'control') {
      const msg = frame.msg
      if (msg.type === 'interrupt') { s.ac?.abort(); return }
      if (msg.type === 'voice') {
        s.voice = msg.voice as string
        s.ttsProvider = typeof msg.provider === 'string' && msg.provider ? msg.provider : null
        return
      }
      if (msg.type === 'model') { s.model = typeof msg.modelDefId === 'string' ? msg.modelDefId : null; return }
      // 'profile' / 'execEnabled' frames from old clients are silently ignored —
      // the agent is always fully armed now (single profile; approval gate = safety).
      // Approve/deny resolve a pending approval IMMEDIATELY (like interrupt) — not
      // queued behind the turn lock, so the awaiting turn unblocks.
      if (msg.type === 'approve' || msg.type === 'deny') {
        const id = typeof msg.requestId === 'string' ? msg.requestId : ''
        const pending = s.pendingApprovals.get(id)
        if (pending) {
          clearTimeout(pending.timer)
          s.pendingApprovals.delete(id)
          const outcome = approvalOutcome(
            msg.type === 'approve'
              ? { kind: 'approve', remember: !!msg.remember, pattern: typeof msg.pattern === 'string' ? msg.pattern : undefined, proposedPattern: pending.req.proposedPattern }
              : { kind: 'deny' }
          )
          if (outcome.persist && outcome.pattern) {
            addApproval({ pattern: outcome.pattern, tool: pending.req.tool }).catch(err => console.error('[exec] persist approval failed:', err))
          }
          recordEvent({ kind: 'tool', name: 'exec:approval', severity: 'info', meta: { outcome: msg.type, command: pending.req.command, pattern: outcome.pattern, remembered: outcome.persist } })
          pending.resolve({ approved: outcome.approved })
        }
        return
      }
      // load: restore a previous conversation under the lock so history is consistent
      if (msg.type === 'load' && typeof msg.conversationId === 'string') {
        s.lock = s.lock.then(async () => {
          try {
            s.history = await getAgentHistory(msg.conversationId as string)
            s.conversationId = msg.conversationId as string
          } catch (err) {
            console.error('[agent] load failed:', err)
            peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'failed to load conversation' }))
          }
        })
        return
      }
      // new: reset to a fresh conversation
      if (msg.type === 'new') { s.history = []; s.conversationId = null; return }
      if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.trim()) {
        // Typed turn: inject post-STT — same agent loop, same TTS, same events.
        const text = msg.text.trim()
        const speak = typeof msg.speak === 'boolean' ? msg.speak : false
        const attachments = Array.isArray(msg.attachments) ? (msg.attachments as AttachmentRef[]) : []
        turnAttachments = attachments
        inputModality = 'text'
        speakFlag = speak
        turn = (signal, emit, context) => handleTurn(text, s.history, { tts, voice: s.voice, ttsProvider: s.ttsProvider, speak, context, modelDefId: s.model, buildMemoryContext, requestApproval, attachments, signal, emit })
      } else {
        return
      }
    } else {
      const audio = frame.bytes
      inputModality = 'voice'
      speakFlag = true
      turn = (signal, emit, context) => handleUtterance(audio, s.history, { stt, tts, voice: s.voice, ttsProvider: s.ttsProvider, speak: true, context, modelDefId: s.model, buildMemoryContext, requestApproval, signal, emit })
    }
    s.ac?.abort()
    for (const [, p] of s.pendingApprovals) { clearTimeout(p.timer); p.resolve({ approved: false }) }
    s.pendingApprovals.clear()
    s.ac = new AbortController()
    const ac = s.ac
    const exec = turn
    const run = async () => {
      try {
        // Live context is rebuilt EVERY turn (two cheap indexed queries) — the old
        // once-per-connection cache went stale (a task created mid-conversation
        // never appeared).
        const context = (await buildLiveContext(new Date())) || undefined
        let reasoningText = ''
        const prevLen = s.history.length
        const emit = (e: VoiceEvent) => {
          if (e.type === 'audio') peer.send(e.bytes)
          else {
            if (e.type === 'reasoning') reasoningText += e.text
            peer.send(JSON.stringify(e))
          }
        }
        s.history = await exec!(ac.signal, emit, context)
        const added = s.history.slice(prevLen)                // [user] or [user, assistant]
        if (added.length && !ac.signal.aborted) {
          const created = prevLen === 0 && !s.conversationId
          if (!s.conversationId) s.conversationId = (await createConversation({ title: deriveTitle(messageText(added[0]!.content)) })).id
          await appendMessages(s.conversationId, added.map(m => ({
            role: m.role as 'user' | 'assistant',
            // Attachment markers are a live-turn signal only. Persisting one makes it durable:
            // it is replayed on every future turn and, once flattened into `content`, is no
            // longer a separate part the resume-path filter can remove.
            content: messageText(withoutAttachmentMarkers(m.content)),
            modality: m.role === 'user' ? inputModality : (speakFlag ? 'voice' : 'text'),
            toolCalls: m.role === 'assistant' && m.toolRecords?.length ? m.toolRecords : null,
            reasoning: m.role === 'assistant' ? (reasoningText || null) : null,
            attachments: m.role === 'user' ? turnAttachments : null,
            // NOT populated: runAgent's fullStream loop (server/lib/agent/run.ts) never turns
            // the AI SDK's `finish` part (which carries `totalUsage`) into an AgentEvent, so
            // there is no VoiceEvent for this closure to accumulate the way it does reasoning/
            // tool_calls above. Wiring it needs run.ts + orchestrator.ts changes, out of this
            // task's scope (see task-4-report.md).
            usage: null
          })))
          publishChange({ resource: 'conversation', action: created ? 'created' : 'updated', id: s.conversationId })
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        console.error('[agent] turn failed:', err)
        peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'agent pipeline error' }))
        peer.send(JSON.stringify({ type: 'state', state: 'idle' }))
      }
    }
    s.lock = s.lock.then(run, run)
  },
  close(peer) {
    const s = conns.get(peer)
    s?.ac?.abort()
    if (s) { for (const [, p] of s.pendingApprovals) { clearTimeout(p.timer); p.resolve({ approved: false }) } }
    conns.delete(peer)
  }
})
