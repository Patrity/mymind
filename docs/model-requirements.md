# Voice Agent — Model/Server Requirements (for the homelab/infra agent)

> **Audience:** the coding/infra agent standing up models on the AI rig (`192.168.2.25`).
> **Goal:** provide the local model servers the MyMind voice agent needs. STT stays OpenAI-spec
> (`/v1/audio/transcriptions`); TTS does **not** — Breeze TTS 2 speaks its own multipart contract,
> not the OpenAI `/v1/audio/speech` JSON shape. This doc describes what's actually there, not a
> spec MyMind wishes existed.

Breeze TTS 2 replaced the old two-engine rig (Kokoro + Chatterbox) on 2026-09-15. It occupies
Kokoro's old host and port, is a single engine by design (no fallback), and serves one request at
a time. Everything below was measured against `http://192.168.2.25:8880` on 2026-09-15 — where it
disagrees with the vendor package's own docs, the measurement is what MyMind builds on.

## GPU budget

The rig has 4 GPUs; the ~35B LLM uses 2. The **other 2 GPUs** host STT and Breeze (both small
relative to the LLM and co-reside comfortably). Breeze runs on a dedicated RTX 3090.

| Service | Model | Protocol | Port |
|---|---|---|---|
| STT | faster-whisper `large-v3` (or `large-v3-turbo`) | OpenAI `/v1/audio/transcriptions` | `8881` |
| TTS | Breeze TTS 2 | `POST /v1/audio/speech`, multipart (not OpenAI JSON) | `8880` |

---

## 1. STT — faster-whisper (OpenAI `/v1/audio/transcriptions`)

**Use case:** turn-based transcription. The client detects end-of-utterance (VAD) and sends a
short audio clip (typically 2–8 s); the server returns the full transcript. **Streaming partials
are NOT required.** Whisper is also used to transcribe reference clips uploaded for Breeze voice
cloning/direction presets — same endpoint, same model, no separate service.

**Recommended server:** [**Speaches**](https://github.com/speaches-ai/speaches) (formerly
`faster-whisper-server`) — exposes OpenAI-compatible `/v1/audio/transcriptions`, GPU-accelerated
faster-whisper. (If Speaches is already running on the rig for STT, just confirm it's up with
`large-v3` loaded.)

**Model:** `Systran/faster-whisper-large-v3` (best accuracy) or `...-large-v3-turbo` (faster,
slightly lower accuracy — fine for a personal assistant).

**Validate:**
```bash
curl -s http://192.168.2.25:8881/v1/audio/transcriptions \
  -F 'file=@hello.wav' -F 'model=Systran/faster-whisper-large-v3' -F 'language=en'
# → {"text":"...transcript..."}
```

## 2. TTS — Breeze TTS 2 (`POST /v1/audio/speech`, multipart)

**Use case:** the only TTS engine in the rig. Does voice *design* (describe a voice in prose and
it invents a speaker) and voice *direction* (clone a speaker from a reference clip, then steer
their delivery with an instruction) — a single model covers what used to take Kokoro + Chatterbox.

**Contract — read this before wiring a client.** This is *not* the OpenAI TTS shape:

| | OpenAI / Kokoro (old) | Breeze (now) |
|---|---|---|
| Encoding | JSON body | **`multipart/form-data`** |
| Text field | `input` | **`text`** |
| Voice selection | `voice` enum | **`instruction`** (free text) and/or `ref_audio` |
| Model field | `model` | *(none — one model, field doesn't exist)* |
| Response | complete audio file (mp3/wav) | **raw PCM stream, no header** |
| Concurrency | parallel | **one request at a time** |

**`POST /v1/audio/speech` fields — exactly nine, no more:**

| Field | Notes |
|---|---|
| `text` | required. Supports inline vocal events: `(laugh)`, `(sigh)`, `(cough)`, `(clears throat)` — all four measurably change the rendered audio |
| `instruction` | natural-language voice description; presence switches to design/direction mode |
| `cfg_scale` | instruction adherence; `> 1.0` **requires** `instruction` present or the request 500s |
| `ref_audio` | reference clip file; **must be paired with `ref_text`** |
| `ref_text` | exact transcript of `ref_audio` |
| `seed` | pins the realization — same seed + same params = same voice |
| `temperature` / `top_p` / `top_k` | sampling knobs |

There is no `model` field and no `voice` enum — don't reintroduce either in a client.

**Response:** `200` with a **streaming body of raw PCM — mono, signed 16-bit little-endian, no WAV
header.** The sample rate is **not a constant** — read it from the `x-sample-rate` response header
every time (`x-sample-format` also arrives but isn't documented by the package). A generation
failure can still open with `200 OK` and headers, then die mid-stream (a prompt-ceiling overrun is
invisible in the status code) — a client must count bytes and treat a truncated/empty stream as an
error, not silence.

**`GET /health`** — poll before sending traffic. Returns `503 {"status":"loading"}` during a
**~44 s warmup** after the service starts; `200 {"status":"ok", "sample_rate": ...}` once ready.

**Single-request enforcement is a real `409`**, with a machine-readable body:
```json
{"detail":"An inference request is already running."}
```
Breeze serves one request at a time — anything above it must queue and retry with backoff, not
treat a 409 as a hard failure.

**Validate:**
```bash
# Poll health until ready (up to ~44s after (re)start)
curl -s http://192.168.2.25:8880/health

# Speak — multipart, not JSON
curl -s http://192.168.2.25:8880/v1/audio/speech \
  -F 'text=Hello, this is a test.' \
  -F 'instruction=A calm, warm narrator.' \
  -F 'cfg_scale=4.0' \
  -F 'seed=42' \
  --output raw.pcm
# raw.pcm is headerless mono s16le — read x-sample-rate from the response to play it back
```

---

## Requirements that matter to MyMind (please honor these)

1. **STT stays OpenAI-spec.** `POST /v1/audio/transcriptions` (multipart `file`/`model`/
   `language`, JSON `{text}` back) — unchanged.
2. **TTS is Breeze's own multipart contract**, not OpenAI JSON. Don't front it with an
   OpenAI-shaped shim; MyMind's client speaks the nine-field form directly.
3. **Stable base URLs** reachable from the MyMind container (LXC 114, `192.168.2.89`) over the LAN.
4. **No fallback.** Breeze is the only TTS engine by design — an outage takes spoken replies down
   until it recovers. Don't stand up a second engine "just in case"; that's the two-engine
   complexity this migration removed.

## Env contract (what MyMind reads)

```
AI_STT_BASE_URL=http://192.168.2.25:8881/v1
AI_STT_MODEL=Systran/faster-whisper-large-v3
AI_TTS_BREEZE_BASE_URL=http://192.168.2.25:8880
```

## Done = both pass

- [ ] `curl` STT returns a transcript for a sample wav.
- [ ] `curl` `GET /health` on Breeze returns `200 {"status":"ok"}` (after warmup).
- [ ] `curl` Breeze `/v1/audio/speech` (multipart) returns a nonzero-length raw PCM stream, and the
      response carries `x-sample-rate`.
- [ ] Both reachable from `192.168.2.89` (the MyMind container).
