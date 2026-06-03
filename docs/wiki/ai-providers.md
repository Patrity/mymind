---
title: AI Model Providers
status: shipped
cycle: 1
updated: 2026-06-03
---

# AI Model Providers

All model access is env-configured and OpenAI-spec — swapping a model is an env change, never code. Cycle 1 shipped the **scaffold** (`server/lib/ai/provider.ts`); no role is invoked yet (chat/embedding calls land in cycle 2).

## Factory — `server/lib/ai/provider.ts`
`aiProvider(role, { required? })` returns `{ baseURL?, apiKey?, model? }` from `useRuntimeConfig().ai[role]`. With `{ required: true }` it throws if `baseURL` is unset. Roles: `reasoning` · `bulk` · `embeddings` · `vision` · `stt` · `tts`.

## Env wiring (`nuxt.config.ts` runtimeConfig.ai, `.env.example`)
Each role: `AI_<ROLE>_BASE_URL` / `AI_<ROLE>_API_KEY` / `AI_<ROLE>_MODEL`.

| Role | Intended default | Notes |
|---|---|---|
| `reasoning` | hosted (Haiku/GPT/Gemini Flash via LiteLLM) | quality-sensitive extraction/inference |
| `bulk` | local rig `192.168.2.25:8004/v1` (qwen3.6-27b-coder) | high-volume |
| `embeddings` | TEI `qwen3-embedding-4b` (2560-dim) fronted as `/v1/embeddings` | `halfvec(2560)` + HNSW (cycle 2) |
| `vision` / OCR | local `192.168.2.25:8005/v1` (qwen3-vl-8b) | image-only |
| `stt` | Speaches `192.168.2.25:8881/v1` | |
| `tts` | Kokoro `192.168.2.25:8880/v1` | |

## Next (cycle 2)
The embedding worker imports `aiProvider('embeddings')` to populate `documents.embedding`; enrichment imports `aiProvider('reasoning')`. Embeddings must be exposed via the OpenAI `/v1/embeddings` shape (front TEI with LiteLLM or use the rig gateway).
