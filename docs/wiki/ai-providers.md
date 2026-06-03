---
title: AI Model Providers
status: planned
cycle: 1
updated: 2026-06-02
---

# AI Model Providers

All model access is env-configured and OpenAI-spec, so swapping a model is an env change, never code. Defined by **role**, each with `*_BASE_URL` / `*_API_KEY` / `*_MODEL`:

| Role | Default target | Notes |
|---|---|---|
| `reasoning` | hosted (Haiku/GPT/Gemini Flash via LiteLLM) | hard extraction/inference; quality-sensitive |
| `bulk` | local AI rig (`192.168.2.25`) | high-volume, cheap |
| `embeddings` | TEI `qwen3-embedding-4b` (2560-dim) fronted as `/v1/embeddings` | `halfvec(2560)` + HNSW |
| `vision` / OCR | local `qwen3-vl-8b` (`:8005`) | image-only |
| `stt` | Speaches (`:8881`) | transcription |
| `tts` | Kokoro/Chatterbox (`:8880`/`:8885`) | |

> Status: **planned** — cycle 1 ships the env-wired client factory (`server/lib/ai/provider.ts`) as a scaffold; AI-heavy roles get exercised from cycle 2 on.
