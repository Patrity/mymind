---
title: AI Model Providers
status: shipped
cycle: 12
updated: 2026-06-14
---

# AI Model Providers

Model access is **DB-backed and runtime-editable** via the AI config registry. Providers, models, and per-usage failover chains live in one JSONB document; the `/settings` page and `/onboarding` wizard edit it; the resolver decrypts keys and merges provider+model into ready-to-call chains. **Swapping or adding a model is a UI change, never code, never an env redeploy.** The old `AI_*` env vars are now import-only seeds (see Migration below).

## The config document (`server/lib/ai/registry/types.ts`)

One JSONB row: `settings.key = 'ai_config'`, value = `AiConfigDoc`:

```ts
interface AiConfigDoc {
  version: 1
  providers: ProviderDef[]   // { id, name, kind, baseURL, apiKeyEnc }
  models:    ModelDef[]      // { id, providerId, modelId, label, dim }
  assignments: Record<Usage, string[]>  // usage -> ordered model ids (failover priority)
}
```

- **`USAGES`** = `reasoning` · `bulk` · `embeddings` · `vision` · `stt` · `tts` · `rerank`.
- **`ProviderDef.kind`** is always **`openai-compatible`** (baseURL required). There is **one transport** — non-OpenAI vendors (e.g. Anthropic/Claude) are fronted by an **OpenAI-compatible gateway (LiteLLM)** and configured as a normal `openai-compatible` provider whose baseURL points at the gateway. (Native `anthropic` support and the `@ai-sdk/anthropic` dependency were removed in cycle 21 — see the handover — because the two transports diverged: Anthropic worked on the agent's `languageModel()` path but silently broke on the `chat()` path.) `apiKeyEnc` is AES-GCM ciphertext, **server-only — never serialized to the client.**
- **`ModelDef.dim`** is `EMBEDDING_DIM` (2560) for embedding models, else `null`.
- **`assignments[usage]`** is an *ordered* list of model ids = the failover chain for that usage (first = primary).

## Storage + encryption

- **`store.ts`** — `loadConfig()` / `saveConfig()` / `invalidate()`. Persists the single `ai_config` row (`onConflictDoUpdate`) with an in-process module-level cache (single instance, so explicit invalidation is enough). Reads/writes re-validate through the Zod schema.
- **`crypto.ts`** — `encryptSecret()` / `decryptSecret()`, AES-256-GCM. Stored format: `base64(iv(12) | tag(16) | ciphertext)`. The 32-byte key is taken from `CONFIG_ENC_KEY` (raw 32-byte base64) **when set**; otherwise it is **derived from `BETTER_AUTH_SECRET` via HKDF-SHA256** (fixed salt `mymind-ai-config`, info `ai-config-key`) — so no new required env. If neither `CONFIG_ENC_KEY` nor `BETTER_AUTH_SECRET` is set, encryption throws. A bad `CONFIG_ENC_KEY` (not 32 bytes) also throws.
- **`schema.ts`** — Zod `docSchema` with a `superRefine` for referential integrity (no FKs in a JSONB doc): every model references an existing provider, every assignment references an existing model, `openai-compatible` providers must have a baseURL. `redactDoc()` produces the client-safe view: provider `apiKeyEnc` is stripped and replaced with a boolean `hasKey`; models + assignments pass through unchanged.

## Resolver — `server/lib/ai/registry/resolve.ts`

- **`resolveChain(usage)`** (cached) / **`resolveChainFrom(doc, usage)`** (pure) — builds the ordered, **decrypted** `ResolvedModel[]` chain: walks `assignments[usage]`, joins each model to its provider, decrypts the key. For `embeddings` it filters the chain to dim-2560 models only (you can't fail over to a different embedding dimension). Throws `AiNotConfiguredError` if the chain is empty.
- **`withFailover(usage, fn)`** / `withFailoverOver(...)` — runs `fn` against each `ResolvedModel` in order until one succeeds; throws `AiAllFailedError` with per-attempt errors if all fail. **Failover is throw-driven**: `fn` must `throw` to advance to the next model — returning a sentinel/empty value reads as success and strands the call on a broken provider. The text helper `chat()` (`server/lib/ai/chat.ts`) enforces this via `extractContent()`, which **throws** when the response has no usable assistant content (missing `choices`, empty string, or a non-JSON body such as an HTML error page returned with HTTP 200). *(This is what masked a misconfigured provider in cycle 21: a 200 + HTML body returned `''`, looked like success, and never failed over.)*
- **`languageModel(m)`** — builds a `createOpenAICompatible` AI SDK model (single transport; all providers are OpenAI-compatible). Consumers (reasoning/bulk/vision LLM roles, embeddings, etc.) call `withFailover` rather than touching env.

## Endpoints (`server/api/settings/`)

| Method + path | Does |
|---|---|
| `GET /api/settings/ai-config` | Redacted read — returns `redactDoc(loadConfig())`. Provider keys appear only as `hasKey: boolean`. |
| `PUT /api/settings/ai-config` | Validates + saves the whole doc. Keys are write-only: each provider's `key` field is `{apiKey}` (encrypt new), `{keep:true}` (reuse stored ciphertext by id), or `null` (clear). **Blanket 422** on any invalid body (raw shape OR referential). If embeddings are assigned, runs a **dim-probe** against the primary embedding model's `/embed` (`{inputs:['probe']}`, 15s timeout) and 422s unless it returns exactly 2560 dims — so you can't save an unreachable or wrong-dimension embedding model. |
| `POST /api/settings/test-provider` | Reachability + auth check: `GET {baseURL}/models` with the bearer key. Accepts inline (not-yet-saved) form config, or reuses a stored key by `id`. Returns `{ ok, message: "HTTP <status>" }`. |
| `POST /api/settings/import-env` | One-time onboarding seed from leftover `AI_*` env (see Migration). **422s if a config already exists** (non-empty registry) — it is a one-time seed only, so it can't blow away a populated `ai_config` row. |

## UI

### `/settings` — `app/pages/settings.vue`

`UDashboardPanel` + `UTabs`, three tabs:

1. **Providers** (`ProvidersTab.vue` + `ProviderForm.vue`) — CRUD over providers. Every provider is `openai-compatible`, so the form is name + base URL + key (no kind selector). Key field is **write-only** (you set or clear it, you never read it back); a **Test** button calls `test-provider`.
2. **Models** (`ModelsTab.vue` + `ModelForm.vue`) — CRUD over models (provider + literal `modelId` + label). An embedding toggle sets `dim = 2560`.
3. **Model Configuration** (`AssignmentsTab.vue` + `AssignmentChain.vue`) — per-usage **draggable failover chains** (drag to reorder priority) via `@vueuse/integrations/useSortable` + sortablejs. The embeddings chain's model dropdown is filtered to dim-2560 models.

State flows through **`app/composables/useAiConfig.ts`** — a shared `useState` editable draft with `load()` / `save()` (PUT the whole doc) / `testProvider()` / `importEnv()` and provider/model/assignment CRUD. Keys are tracked client-side as: existing untouched → `{keep:true}`, typed → `{apiKey}`, cleared → `null`. A sidebar nav link to `/settings` lives in `app/layouts/default.vue`.

### `/onboarding` — first-run gate

- **`app/middleware/onboarding.global.ts`** — after auth, redirects to `/onboarding` until configured. Exempts `/login`, `/onboarding`, and `/share/**`.
- **`app/composables/useAiConfigStatus.ts`** — cached `needsOnboarding`, true until **both** `reasoning` AND `embeddings` have ≥1 assigned model.
- **`app/pages/onboarding.vue`** — a `UStepper` wizard reusing the three settings tabs, plus an **"Import from environment"** button (loading + error feedback) that calls `import-env`. **Finish** is gated on reasoning+embeddings being assigned → saves → refreshes status → navigates home.

## Migration — `AI_*` env vars are now import-only

Older builds configured each role through `AI_<ROLE>_BASE_URL` / `_API_KEY` / `_MODEL` env vars resolved at runtime by an `aiProvider()` factory. That env-driven runtime config has been **replaced** by the registry. The `AI_*` vars now have exactly one job: a **one-time onboarding seed**, consumed only by the Import button when the config is empty.

`POST /api/settings/import-env` (`import-env.post.ts`) reads `process.env` directly, maps the old roles → usages (`AI_REASONING`→reasoning, `AI_BULK`→bulk, `AI_EMBEDDINGS`→embeddings (dim 2560), `AI_VISION`→vision, `AI_STT`→stt, `AI_TTS_KOKORO` + `AI_TTS_CHATTERBOX`→tts, `AI_RERANK`→rerank), dedupes providers by baseURL, encrypts keys, and saves. It builds from `emptyDoc()` and writes the whole `ai_config` row, so to protect a populated config it now **422s if a config already exists** — it is a strictly one-time seed for an empty registry, surfaced only via the onboarding Import button, not a merge. After onboarding, the `AI_*` vars do nothing at runtime; all model config lives in the DB and is edited in `/settings`.
