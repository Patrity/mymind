# Voice Agent — Model/Server Requirements (for the homelab/infra agent)

> **Audience:** the coding/infra agent standing up models on the AI rig (`192.168.2.25`).
> **Goal:** provide the three local model servers the MyMind voice agent needs, **all behind standard OpenAI-spec HTTP APIs** (no custom protocols). MyMind talks to them only via `/v1/audio/transcriptions` (STT) and `/v1/audio/speech` (TTS), so anything that speaks those endpoints is a drop-in.

We are **removing the Unmute/Kyutai stack** and orchestrating the voice loop ourselves in TypeScript. These servers replace it.

## GPU budget
The rig has 4 GPUs; the ~35B LLM uses 2. The **other 2 GPUs** host STT + both TTS servers (all three are small relative to the LLM and co-reside comfortably).

| Service | Model | GPU | Protocol | Suggested port |
|---|---|---|---|---|
| STT | faster-whisper `large-v3` (or `large-v3-turbo`) | GPU 1 | OpenAI `/v1/audio/transcriptions` | `8881` |
| TTS — Kokoro | `kokoro` (82M) | GPU 1 | OpenAI `/v1/audio/speech` | `8880` |
| TTS — Chatterbox | Resemble Chatterbox | GPU 1 | OpenAI `/v1/audio/speech` | `8884` |

(Ports are suggestions — set whatever you like; MyMind reads them from env, see the contract below.)

---

## 1. STT — faster-whisper (OpenAI `/v1/audio/transcriptions`)

**Use case:** turn-based transcription. The client detects end-of-utterance (VAD) and sends a short audio clip (typically 2–8 s); the server returns the full transcript. **Streaming partials are NOT required.**

**Recommended server:** [**Speaches**](https://github.com/speaches-ai/speaches) (formerly `faster-whisper-server`) — exposes OpenAI-compatible `/v1/audio/transcriptions`, GPU-accelerated faster-whisper. (If Speaches is already running on the rig for STT, just confirm it's up with `large-v3` loaded.)

**Model:** `Systran/faster-whisper-large-v3` (best accuracy) or `...-large-v3-turbo` (faster, slightly lower accuracy — fine for a personal assistant).

**Validate:**
```bash
curl -s http://192.168.2.25:8881/v1/audio/transcriptions \
  -F 'file=@hello.wav' -F 'model=Systran/faster-whisper-large-v3' -F 'language=en'
# → {"text":"...transcript..."}
```

## 2. TTS — Kokoro (OpenAI `/v1/audio/speech`)

**Use case:** fast, clean default voice. Lowest latency, simplest. 82M params, tiny footprint.

**Recommended server:** [**Kokoro-FastAPI / docker-kokoro**](https://github.com/hwdsl2/docker-kokoro) (the hwdsl2 build has proper streaming: `stream_format: audio` chunked or `sse`), **or** Speaches (it also serves Kokoro behind `/v1/audio/speech`). Either is fine — both are OpenAI-spec.

**Validate:**
```bash
curl -s http://192.168.2.25:8880/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{"model":"kokoro","voice":"af_heart","input":"Hello, this is a test.","response_format":"wav"}' \
  --output kokoro.wav
curl -s http://192.168.2.25:8880/v1/voices   # list available voices
```

## 3. TTS — Chatterbox (OpenAI `/v1/audio/speech`)

**Use case:** the more natural / expressive voice and the quality-per-latency default. Supports voice cloning and streaming.

**Recommended server:** [**devnen/Chatterbox-TTS-Server**](https://github.com/devnen/Chatterbox-TTS-Server) — exposes OpenAI-compatible `/v1/audio/speech` (+ `/v1/audio/voices`). Enable streaming output if the build supports it (token/chunk streaming forks: `davidbrowne17/chatterbox-streaming`).

**Validate:**
```bash
curl -s http://192.168.2.25:8884/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{"model":"chatterbox","voice":"default","input":"Hello, this is a test.","response_format":"wav"}' \
  --output chatterbox.wav
```

---

## Requirements that matter to MyMind (please honor these)

1. **OpenAI-spec only.** STT must answer `POST /v1/audio/transcriptions` (multipart `file`/`model`/`language`, JSON `{text}` back). TTS must answer `POST /v1/audio/speech` (JSON `{model,voice,input,response_format}`, audio bytes back). **Streaming TTS is a plus** (HTTP chunked or SSE) — MyMind will stream per-sentence either way.
2. **Stable base URLs** reachable from the MyMind container (LXC 114, `192.168.2.89`) over the LAN.
3. **`response_format` support:** `wav` and/or `pcm` preferred (simplest for the browser to play); `mp3` acceptable.
4. **List endpoints** (`/v1/voices` or `/v1/audio/voices`) if available, so MyMind can populate the voice picker live.

## Env contract (what MyMind will read)
Set these in MyMind's `.env` once the servers are up (final names finalized in the build, but expect):
```
AI_STT_BASE_URL=http://192.168.2.25:8881/v1
AI_STT_MODEL=Systran/faster-whisper-large-v3
AI_TTS_KOKORO_BASE_URL=http://192.168.2.25:8880/v1
AI_TTS_CHATTERBOX_BASE_URL=http://192.168.2.25:8884/v1
```

## Done = all three pass
- [ ] `curl` STT returns a transcript for a sample wav.
- [ ] `curl` Kokoro returns playable audio + `/v1/voices` lists voices.
- [ ] `curl` Chatterbox returns playable audio.
- [ ] All three reachable from `192.168.2.89` (the MyMind container).
