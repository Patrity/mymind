// server/api/voice/ws.ts
import { handleUtterance, handleTurn, type VoiceEvent } from '../../lib/voice/orchestrator'
import { classifyFrame } from '../../lib/voice/frames'
import { sttFromModel, ttsFromModel } from '../../lib/voice/providers'
import type { SttProvider, TtsProvider } from '../../lib/voice/providers/types'
import { withFailover } from '../../lib/ai/registry/resolve'
import type { AgentMessage } from '../../lib/agent/run'
import { createConversation, appendMessages, getAgentHistory, deriveTitle } from '../../services/conversations'
import { buildLiveContext } from '../../lib/agent/context'
import { publishChange } from '../../utils/live-bus'
import { profileById } from '../../lib/agent/profile'
import type { ApprovalRequest } from '../../lib/agent/types'
import { loadApprovals, addApproval, touchApproval, matchesApproval, approvalOutcome } from '../../lib/exec/approvals'
import { recordEvent } from '../../lib/observability/record'
import { randomUUID } from 'node:crypto'

// Client→server: binary frame = one WAV utterance | text JSON {type:'interrupt'} |
//   {type:'voice',voice} | {type:'text',text,speak?} (typed turn, injected post-STT) |
//   {type:'load',conversationId} (load existing conversation) | {type:'new'} (reset)
// Server→client: binary = audio bytes | text JSON = transcript/tool/state/error events.
interface ConnState {
  history: AgentMessage[]
  ac: AbortController | null
  voice: string
  lock: Promise<void>
  conversationId: string | null
  context: string | null
  profile: 'bridget' | 'powerful'
  execEnabled: boolean
  pendingApprovals: Map<string, { resolve: (d: { approved: boolean }) => void; timer: ReturnType<typeof setTimeout>; req: ApprovalRequest }>
}
const conns = new WeakMap<object, ConnState>()

// STT/TTS resolved from the registry at call time, with per-usage failover.
const stt: SttProvider = {
  transcribe: (audio, opts) =>
    withFailover('stt', m => sttFromModel(m).transcribe(audio, opts))
}
const tts: TtsProvider = {
  synthesize: (text, opts) => ttsSynthFailover(text, opts)
}

async function* ttsSynthFailover(text: string, opts: { voice: string; signal?: AbortSignal }) {
  // tts-openai buffers the whole WAV per call, so we can collect all chunks
  // INSIDE withFailover — a provider that errors on synthesis falls over to the
  // next, and only a fully-synthesized result is yielded. (Failover is per turn,
  // not mid-stream — acceptable since each utterance is one buffered WAV.)
  const chunks = await withFailover('tts', async (m) => {
    const out: Uint8Array[] = []
    for await (const c of ttsFromModel(m).synthesize(text, opts)) out.push(c)
    return out
  })
  yield* chunks
}

export default defineWebSocketHandler({
  // Server middleware does NOT run for WS upgrades (crossws handles them directly),
  // so the session must be validated here — this socket drives the full agent.
  // Returning a non-ok Response makes crossws reject the upgrade.
  async upgrade(request) {
    const session = await useAuth().api.getSession({ headers: request.headers as Headers }).catch(() => null)
    if (!session?.user) return new Response('Unauthorized', { status: 401 })
  },
  open(peer) {
    conns.set(peer, { history: [], ac: null, voice: '', lock: Promise.resolve(), conversationId: null, context: null, profile: 'bridget', execEnabled: false, pendingApprovals: new Map() })
  },
  message(peer, message) {
    const s = conns.get(peer); if (!s) return
    // Classify by CONTENT, not transport type: crossws@0.3.5's node adapter drops
    // the isBinary flag, so JSON control frames arrive as Buffers (see frames.ts).
    const frame = classifyFrame(typeof message.rawData === 'string' ? message.rawData : message.uint8Array())
    if (frame.kind === 'ignore') return
    // A turn closure reads s.history at EXECUTION time (under the lock), so
    // back-to-back turns see each other's appended messages.
    let turn: ((signal: AbortSignal, emit: (e: VoiceEvent) => void) => Promise<AgentMessage[]>) | null = null
    let inputModality: 'text' | 'voice' = 'text'
    let speakFlag = false
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
    const profile = profileById(s.profile)
    if (frame.kind === 'control') {
      const msg = frame.msg
      if (msg.type === 'interrupt') { s.ac?.abort(); return }
      if (msg.type === 'voice') { s.voice = msg.voice as string; return }
      // Profile switch (per-connection; default safe). Affects subsequent turns.
      if (msg.type === 'profile') { s.profile = msg.profile === 'powerful' ? 'powerful' : 'bridget'; return }
      // Exec gate: per-session master enable switch (cookie-armed, default off).
      if (msg.type === 'execEnabled') { s.execEnabled = msg.value === true; return }
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
            s.context = null
          } catch (err) {
            console.error('[agent] load failed:', err)
            peer.send(JSON.stringify({ type: 'error', message: (err as Error).message || 'failed to load conversation' }))
          }
        })
        return
      }
      // new: reset to a fresh conversation
      if (msg.type === 'new') { s.history = []; s.conversationId = null; s.context = null; return }
      if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.trim()) {
        // Typed turn: inject post-STT — same agent loop, same TTS, same events.
        const text = msg.text.trim()
        const speak = typeof msg.speak === 'boolean' ? msg.speak : false
        inputModality = 'text'
        speakFlag = speak
        turn = (signal, emit) => handleTurn(text, s.history, { tts, voice: s.voice, speak, context: s.context ?? undefined, profile, execEnabled: s.execEnabled, requestApproval, signal, emit })
      } else {
        return
      }
    } else {
      const audio = frame.bytes
      inputModality = 'voice'
      speakFlag = true
      turn = (signal, emit) => handleUtterance(audio, s.history, { stt, tts, voice: s.voice, speak: true, context: s.context ?? undefined, profile, execEnabled: s.execEnabled, requestApproval, signal, emit })
    }
    s.ac?.abort()
    for (const [, p] of s.pendingApprovals) { clearTimeout(p.timer); p.resolve({ approved: false }) }
    s.pendingApprovals.clear()
    s.ac = new AbortController()
    const ac = s.ac
    const exec = turn
    const run = async () => {
      try {
        if (!s.context) s.context = await buildLiveContext(new Date())
        const toolCalls: { name: string; summary: string; undoToken?: string }[] = []
        const prevLen = s.history.length
        const emit = (e: VoiceEvent) => {
          if (e.type === 'audio') peer.send(e.bytes)
          else { if (e.type === 'tool') toolCalls.push({ name: e.name, summary: e.summary, undoToken: e.undoToken }); peer.send(JSON.stringify(e)) }
        }
        s.history = await exec!(ac.signal, emit)               // exec built with speak+context
        const added = s.history.slice(prevLen)                // [user] or [user, assistant]
        if (added.length && !ac.signal.aborted) {
          const created = prevLen === 0 && !s.conversationId
          if (!s.conversationId) s.conversationId = (await createConversation({ title: deriveTitle(added[0]!.content) })).id
          await appendMessages(s.conversationId, added.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
            modality: m.role === 'user' ? inputModality : (speakFlag ? 'voice' : 'text'),
            toolCalls: m.role === 'assistant' && toolCalls.length ? toolCalls : null
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
