# Voice Agent Integration Guide (Kyutai / Unmute backend)

Handover doc for integrating a **real-time, interruptible voice conversation** into an existing
app. The backend is already deployed and validated; this describes the API you build a client against.

> **TL;DR for the implementing agent:** Open a WebSocket to `…/api/v1/realtime` (subprotocol
> `realtime`). Exchange **JSON text** events modeled on the OpenAI Realtime API. Audio is **base64-encoded
> Opus** (24 kHz mono) carried inside those JSON events. Use the [`opus-recorder`](https://github.com/chris-rudmin/opus-recorder)
> library for both mic encoding and playback decoding, with the exact settings in §6. Interruption/barge-in
> is automatic (server-side semantic VAD) — you just keep streaming the mic. **Mic capture requires a secure
> context: HTTPS or `localhost`.**

---

## 1. Architecture

```
Your app (browser client)
   │  WebSocket (JSON events, base64 Opus audio)
   ▼
Unmute backend  ──ws──►  Kyutai STT (transcribe, semantic VAD)
   │                ──http─► LLM (Qwen3.6-27B coder, OpenAI-compatible)
   │                ──ws──►  Kyutai TTS (streaming speech)
   ▼
Your app  ◄── streamed transcript + assistant text + assistant audio (Opus)
```

The backend orchestrates STT → LLM → TTS and handles turn-taking and interruption. **Your client only
deals with: capture mic → send Opus; receive Opus → play; render transcripts/text.** You do **not** call
the LLM/STT/TTS yourself.

---

## 2. Connection

| | |
|---|---|
| **URL** | `ws(s)://<host>/api/v1/realtime` |
| **Subprotocol** | `realtime` (must be sent, e.g. `new WebSocket(url, ["realtime"])`) |
| **Transport** | text frames, each a JSON object with a `type` field |
| **Auth** | none currently (LAN-internal). Add a reverse-proxy auth layer if exposing publicly. |

**Current deployment hosts (pick per environment):**
- Via SSH tunnel (dev, mic works because it's localhost): tunnel `80→localhost:8080`, then
  `ws://localhost:8080/api/v1/realtime`
- LAN direct: `ws://192.168.2.25/api/v1/realtime` *(mic blocked unless you serve your app over HTTPS or use a localhost tunnel — see §9)*
- Future HTTPS (recommended for production): `wss://<your-domain>/api/v1/realtime`

> ⚠️ **Secure-context rule:** Browsers only grant microphone access (`getUserMedia`) on **HTTPS** or
> **`localhost`/`127.0.0.1`**. Plain `http://` on a LAN IP will fail at mic acquisition before any
> WebSocket is opened. Serve your client over HTTPS, or develop against a localhost tunnel.

---

## 3. Protocol overview

- Both directions are **JSON text frames**. Every message has a `"type"`.
- Modeled on the **OpenAI Realtime API** ("ORA"), plus Unmute-specific `unmute.*` events.
- **Audio payloads are base64-encoded Opus** (Ogg/Opus stream pages), inside `audio`/`delta` string fields.
- Audio format everywhere: **24 000 Hz, mono, Opus.**

---

## 4. Session lifecycle

1. **Connect** the WebSocket (subprotocol `realtime`).
2. **Send `session.update`** to configure voice + system prompt (instructions) + recording consent.
   (Recommended to send immediately on open, before audio.)
3. **Start streaming mic audio**: continuously send `input_audio_buffer.append` with base64 Opus chunks.
4. **Receive, concurrently:**
   - `conversation.item.input_audio_transcription.delta` — your speech, transcribed (streaming).
   - `input_audio_buffer.speech_started` / `…speech_stopped` — VAD turn signals.
   - `response.created`, then `response.text.delta` (assistant text) and `response.audio.delta`
     (assistant speech, base64 Opus) — **play these as they arrive**.
   - `response.text.done` / `response.audio.done` — turn finished.
5. **Interruption:** if you talk while the assistant is speaking, the server emits
   `unmute.interrupted_by_vad` and stops the current response. **Your client must immediately stop/flush
   playback of buffered assistant audio** when it sees this (and on the next `response.created`).
6. **Close** the WebSocket to end the session.

You never send a "commit" or "create response" — the server decides when you've finished a turn (semantic
VAD) and responds automatically. Keep the mic stream flowing the whole time.

---

## 5. Message reference

### 5.1 Client → Server

#### `session.update` — configure the session
```json
{
  "type": "session.update",
  "session": {
    "instructions": {
      "type": "constant",
      "text": "You are a helpful assistant for <app>. Be concise and conversational.",
      "language": null
    },
    "voice": "unmute-prod-website/developer-1.mp3",
    "allow_recording": false
  }
}
```
- `instructions` *(object, optional)* — sets the assistant persona/behavior. Use
  `{"type":"constant","text":"…","language":null}` for a custom system prompt. `text` is merged into the
  backend's base system-prompt template. `language` may be `"en"`, `"fr"`, `"en/fr"`, `"fr/en"`, or `null`.
  (Other built-in types exist — `smalltalk`, `news`, `quiz_show`, `guess_animal` — but `constant` is what
  you want for app integration.)
- `voice` *(string, optional)* — a `path_on_server` voice id (see §7). Omit for the default.
- `allow_recording` *(bool, required)* — whether the server may record the conversation. Set `false`
  unless you have user consent.

The server replies with `session.updated` echoing the applied config. You may send `session.update` again
mid-session to change voice/instructions.

#### `input_audio_buffer.append` — stream mic audio
```json
{ "type": "input_audio_buffer.append", "audio": "<base64 Opus bytes>" }
```
Send continuously while the mic is open (one message per encoded Opus chunk). See §6 for encoding.

### 5.2 Server → Client

| Event `type` | Payload | Meaning / what to do |
|---|---|---|
| `session.updated` | `{ session }` | Config applied. |
| `input_audio_buffer.speech_started` | — | VAD detected you started talking. |
| `input_audio_buffer.speech_stopped` | — | VAD detected you stopped (turn boundary). |
| `conversation.item.input_audio_transcription.delta` | `{ delta, ... }` | Streaming transcript of **your** speech. Render as live captions. |
| `response.created` | `{ response }` | Assistant turn starting. Reset your assistant audio/text buffers. |
| `response.text.delta` | `{ delta }` | Assistant **text** token(s). Append to transcript UI. |
| `response.text.done` | `{ text }` | Assistant text complete for this turn. |
| `response.audio.delta` | `{ delta }` | Assistant **speech**, base64 Opus. Decode + play immediately. |
| `response.audio.done` | — | Assistant audio complete for this turn. |
| `unmute.interrupted_by_vad` | — | **You interrupted.** Stop/flush assistant playback now. |
| `error` | `{ error: { type, message } }` | Error (`type` may be `fatal`). Surface + reconnect if fatal. |
| `unmute.additional_outputs`, `unmute.response.text.delta.ready`, `unmute.response.audio.delta.ready` | — | Internal/extension signals; safe to ignore for a basic client. |

---

## 6. Audio encoding (the part to get exactly right)

Audio in **both** directions is **Opus, 24 000 Hz, mono**, base64-encoded inside the JSON events. The
reference client uses [`opus-recorder`](https://github.com/chris-rudmin/opus-recorder) (which bundles the
libopus encoder/decoder as WASM + AudioWorklet). Match these settings exactly.

**Mic → server (encoder), per the deployed frontend (`frontend/src/app/useAudioProcessor.ts`):**
```js
const recorderOptions = {
  encoderFrameSize: 20,          // ms
  encoderSampleRate: 24000,      // Hz
  maxFramesPerPage: 2,
  numberOfChannels: 1,
  encoderApplication: 2049,      // OPUS_APPLICATION_AUDIO
  streamPages: true,             // emit Ogg/Opus pages as a stream
  bufferLength: Math.round((960 * audioContext.sampleRate) / 24000),
};
// On each emitted page: base64-encode the bytes and send as input_audio_buffer.append { audio }
```

**Server → playback (decoder):**
```js
{
  decoderSampleRate: 24000,
  outputBufferSampleRate: audioContext.sampleRate,  // your AudioContext rate
  // base64-decode each response.audio.delta, feed bytes to the Opus decoder worklet, play
}
```

> The backend reads the Opus stream with Kyutai's `sphn.OpusStreamReader(24000)` and writes with
> `OpusStreamWriter(24000)`. The `streamPages: true` Ogg framing from opus-recorder is what it expects —
> don't send raw/un-paged Opus or a different sample rate.

**Strongly recommended:** rather than reimplement, port the audio plumbing from the Unmute frontend
(`useAudioProcessor.ts`, `Unmute.tsx`, `VoiceRecorder.tsx`, `useMicrophoneAccess.ts`). It already handles
encoder/decoder lifecycle, AudioWorklets, and base64 framing correctly.

---

## 7. Voices

Set `session.voice` to a voice id (a `path_on_server`). Built-in options (from `voices.yaml`):

| Voice id (`path_on_server`) | Character | Notes |
|---|---|---|
| `unmute-prod-website/developer-1.mp3` | Dev (news) | neutral, US |
| `unmute-prod-website/p329_022.wav` | Watercooler | casual |
| `unmute-prod-website/ex04_narration_longform_00001.wav` | Explanation | narration |
| `unmute-prod-website/developpeuse-3.wav` | Développeuse | FR |
| `unmute-prod-website/degaulle-2.wav` | Charles | FR |
| `unmute-prod-website/fabieng-enhanced-v2.wav` | Fabieng | FR |

Any voice from the [`kyutai/tts-voices`](https://huggingface.co/kyutai/tts-voices) HF repo also works
(e.g. `voice-donations/<Name>.wav`) — the full set is downloaded on the TTS server. Omit `voice` for the
default. Each built-in voice in `voices.yaml` also carries suggested `instructions`; you can override with
your own `constant` instructions.

---

## 8. Capabilities

- **Full-duplex, low-latency conversation.** TTS begins before the LLM finishes the sentence; end-to-end
  response latency is typically sub-second.
- **Automatic interruption / barge-in.** Server-side semantic VAD stops the assistant when the user speaks;
  you get `unmute.interrupted_by_vad`. No client logic needed beyond flushing playback.
- **Streaming transcripts** of the user (`…transcription.delta`) and **streaming assistant text**
  (`response.text.delta`) — good for live captions / a chat transcript pane.
- **Configurable persona** via `instructions` and **voice** via `voice`, changeable mid-session.
- **LLM is your existing coder model** (`qwen3.6-27b-coder`) — i.e., the assistant is as capable as that
  model. The backend wraps your `instructions.text` in a system-prompt template.

---

## 9. Practical notes & gotchas

- **Secure context for mic** (repeat, because it's the #1 trap): HTTPS or `localhost` only. For production,
  serve your app over HTTPS and use `wss://`. For dev, tunnel the backend to localhost.
- **Mixed content:** if your app is on HTTPS, the WebSocket must be `wss://` (not `ws://`), or the browser
  blocks it. Terminate TLS at a reverse proxy in front of the backend.
- **Keep the mic stream continuous.** Don't gate sending on VAD yourself — the server's VAD needs the
  steady stream to detect turns and interruptions.
- **On `response.created` and `unmute.interrupted_by_vad`, flush queued assistant audio** so a barge-in
  feels instant and old audio doesn't play over the new turn.
- **AudioContext sample rate ≠ 24 kHz is fine** — opus-recorder resamples; that's why `outputBufferSampleRate`
  / `bufferLength` use `audioContext.sampleRate`.
- **Reconnect** on `error` with `type: "fatal"` or socket close; re-send `session.update` after reconnect.
- **No built-in auth.** If you expose this beyond the LAN, put authentication in the reverse proxy.

---

## 10. Reference implementation files (Unmute repo)

If the implementing agent can access the Unmute source (`github.com/kyutai-labs/unmute`), these are the
files to mirror:

| File | What it shows |
|---|---|
| `frontend/src/app/Unmute.tsx` | WS connection (`…/v1/realtime`, subprotocol `realtime`), event loop |
| `frontend/src/app/useAudioProcessor.ts` | opus-recorder encoder/decoder setup (the §6 settings) |
| `frontend/src/app/VoiceRecorder.tsx`, `useMicrophoneAccess.ts` | mic capture + secure-context handling |
| `unmute/openai_realtime_api_events.py` | authoritative event schema (all message types/fields) |
| `unmute/main_websocket.py` | server route `/v1/realtime`, Opus read/write, JSON framing |
| `unmute/llm/system_prompt.py` | `ConstantInstructions` and other instruction types |
| `voices.yaml` | voice catalog |

---

## 11. Quick connection smoke test (no audio)

To verify reachability/config before wiring audio:
```js
const ws = new WebSocket("ws://localhost:8080/api/v1/realtime", ["realtime"]);
ws.onopen = () => ws.send(JSON.stringify({
  type: "session.update",
  session: { instructions: { type: "constant", text: "Be brief." }, allow_recording: false }
}));
ws.onmessage = (e) => console.log("event:", JSON.parse(e.data).type);  // expect "session.updated"
```
A `session.updated` event back confirms the protocol path end-to-end. Add audio (§6) next.
