# AI Config Registry & Settings UI — Design Spec

**Date:** 2026-06-10
**Status:** approved design, pre-plan
**Replaces:** env-based AI provider/model config (`runtimeConfig.ai`, `aiProvider()`, `AI_*` env vars, the `NUXT_AI_*` compose mappings)

## 1. Goal

Move all AI provider/model configuration out of env and into a database-backed registry with a `/settings` UI (Providers, Models, Model Configuration tabs) and a first-run onboarding wizard. Each usage type (reasoning, bulk, embeddings, vision, stt, tts, rerank) is assigned an **ordered failover chain** of models, configured by a draggable list. Provider API keys are encrypted at rest.

## 2. Decisions (settled during brainstorm)

- **DB fully replaces env** for AI config. No silent env seeding; config is collected via an **onboarding wizard after admin account creation**. A one-time **"Import from environment"** button in onboarding reads any still-present `AI_*` values directly from `process.env` (server-side, since `runtimeConfig.ai` is being deleted) and pre-fills providers/models to ease the cutover; you review and save, after which env is gone.
- **Storage = a single JSONB document**, not normalized tables and not a flat file. One row in a new `settings` table (`key='ai_config'`), validated by zod on read/write. Rationale: rides the existing `pgdata` backup (no new volume, unlike a file), transactional whole-document swap (no atomic-write helper), no relational ceremony for a ~50-row read-mostly dataset that the resolver loads wholesale anyway.
- **Secrets encrypted at rest** (AES-256-GCM), key derived from the already-required `BETTER_AUTH_SECRET` via HKDF (optional `CONFIG_ENC_KEY` override). Never serialized to the client.
- **Multi-model = ordered failover chain**, configured via a draggable list (`useSortable`). Order = priority.
- **Embeddings dimension pinned at 2560**: configurable like any role, but a save-time probe rejects a model whose output length ≠ 2560; failover is filtered to dim-2560 models. Dimension change / re-index is out of scope.

## 3. The config document

One row: `settings(key='ai_config', value=jsonb)`, zod-validated. Shape:

```jsonc
{
  "version": 1,
  "providers": [
    { "id": "uuid", "name": "Claude API",
      "kind": "anthropic",              // | "openai-compatible"
      "baseURL": null,                  // required for openai-compatible; null for anthropic
      "apiKeyEnc": "base64(iv|tag|ct)" }// AES-256-GCM ciphertext; server-only, never to client
  ],
  "models": [
    { "id": "uuid", "providerId": "uuid",  // → providers[].id
      "modelId": "claude-sonnet-4-6",      // literal string sent to the API
      "label": "Claude Sonnet",
      "dim": null }                        // 2560 for embedding models, else null
  ],
  "assignments": {                          // usage → ordered failover chain of model ids
    "reasoning": ["uuid", "uuid"],
    "bulk":      ["uuid"],
    "embeddings":["uuid"],                  // assigned model.dim must equal 2560
    "vision":    ["uuid"],
    "stt":       ["uuid"],
    "tts":       ["uuid"],
    "rerank":    []                         // optional; empty = off
  }
}
```

- **`kind`** selects the SDK adapter: `anthropic` → `@ai-sdk/anthropic` (new dep); `openai-compatible` → `@ai-sdk/openai-compatible` (existing — covers litellm, local vLLM, Kokoro/Chatterbox, faster-whisper).
- **Referential integrity** (no FKs → zod refinement in the save path): every `model.providerId` exists in `providers`; every id in `assignments` exists in `models`; a provider referenced by a model, or a model referenced by an assignment, cannot be deleted — the save is rejected with a clear message.
- **TTS voice is not stored here** — it stays a runtime pick (the `/voice` voice picker + `voice-settings` cookie). The `tts` chain only selects provider+model.

## 4. Server: registry, resolver, failover

New module `server/lib/ai/registry/`:

- `crypto.ts` — `encryptSecret`/`decryptSecret` (AES-256-GCM; key = HKDF-SHA256 over `BETTER_AUTH_SECRET`, salt fixed, info `'ai-config-key'`; optional `CONFIG_ENC_KEY` raw base64 override). Stored `base64(iv(12)|tag(16)|ciphertext)`. Decryption failure → that key reads as missing (clear "re-enter key" error), never a crash.
- `schema.ts` — zod schema + referential refinements; `redactDoc(doc)` strips every `apiKeyEnc`, sets `hasKey`.
- `store.ts` — load/save the JSONB row; in-process module-level cache of the parsed+decrypted doc; `invalidate()` called by the save endpoint (single instance, so no cross-process invalidation needed).
- `resolve.ts`:
  - `resolveChain(usage): ResolvedModel[]` — ordered, decrypted, ready clients. Embeddings filtered to `dim === 2560`.
  - `withFailover(usage, m => fn(m)): Promise<T>` — walk the chain, next on error, collect attempts, throw `AiAllFailedError` if all fail.
  - `languageModel(m): LanguageModel` — kind-aware AI SDK model.

`ResolvedModel = { usage, providerKind, baseURL?, apiKey?, modelId, dim?, label }` (apiKey decrypted, server-only).

**Failover semantics:**
- Non-streaming roles (embeddings, vision, stt, tts, rerank, single-shot bulk): try/catch around the whole call.
- Reasoning (streaming `streamText`): failover **only at stream start** (first request errors before any token). Mid-stream failure surfaces as an error as today.
- Embeddings: dim-gated (chain pre-filtered to 2560).

**Unconfigured = clean dark.** Empty chain → `AiNotConfiguredError(usage)`. App boots; only invoking an unconfigured role errors (clearly, in the UI).

### Consumer refactor (all stop reading `runtimeConfig.ai`)

| Consumer | Change |
|---|---|
| `server/lib/agent/model.ts` `reasoningModel()` | `languageModel(resolveChain('reasoning')[0])`; runAgent wraps stream creation in start-only failover |
| `server/lib/ai/chat.ts` (`aiProvider(role)`) | route through `resolveChain`/`withFailover` |
| `server/lib/ai/vision.ts` | `withFailover('vision', …)` |
| `server/lib/ai/embeddings.ts` | `withFailover('embeddings', …)` (dim-gated) |
| `server/lib/voice/providers/index.ts` `makeStt/makeTts/defaultVoice` | take a `ResolvedModel`; orchestrator calls walk the stt/tts chains via `withFailover` |
| `server/api/voice/voices.get.ts` | list voices for the resolved tts provider(s) |
| `server/lib/ai/rerank.ts` | `resolveChain('rerank')` (empty = off) |

**Deletions:** `runtimeConfig.ai` block in `nuxt.config.ts`, `aiProvider()` in `provider.ts`, the 25 `NUXT_AI_*` mappings in `docker-compose.prod.yml`, the `AI_*` block in `.env.example` (keep `BETTER_AUTH_SECRET`, DB, storage, `ALLOW_SIGNUP`, optional `CONFIG_ENC_KEY`).

## 5. Server: endpoints (auth-gated by existing middleware)

> "Admin" = the authenticated single user. The app has no role system; the existing `server/middleware/auth.ts` already protects all `/api/*` (except public prefixes), so `/api/settings/*` is gated by simply existing. No new authorization layer.

- `GET /api/settings/ai-config` → **redacted** doc (`hasKey` booleans, no ciphertext).
- `PUT /api/settings/ai-config` → whole doc. New keys arrive plaintext (encrypted server-side); existing keys sent as `{keep:true}` (retain ciphertext by id). zod + referential validation → 422 with field messages on failure. Saving an embeddings assignment runs the dim probe (embed a test string; reject if length ≠ 2560). Calls `store.invalidate()`.
- `POST /api/settings/ai-config/test-provider` → ping a provider (inline config or by id); returns `{ok, message}`, never throws to client.

## 6. Client: Settings UI + onboarding

**`/settings`** — `UDashboardPanel` + tabs; all share `composables/useAiConfig.ts` (fetch redacted doc; mutations PUT the whole doc).

- **Providers tab** (`settings/ProvidersTab.vue` + `ProviderForm.vue` slideover): list + add/edit/delete. Fields: name, `kind` (Anthropic / OpenAI-compatible), `baseURL` (shown only for OpenAI-compatible), API key (write-only: `set ••••` + Replace field). Test button.
- **Models tab** (`ModelsTab.vue` + `ModelForm.vue`): list + add/edit/delete. Pick provider (dropdown), model id, label, "embedding model" toggle revealing dim (default 2560).
- **Model Configuration tab** (`AssignmentsTab.vue`): one row per usage; each a draggable failover chain — add from a dropdown of defined models, drag to reorder (`useSortable`), remove. Embeddings dropdown lists only dim-2560 models. Autosaves.

**Onboarding** — `/onboarding` route reusing the three tab components in a stepper: ① add a provider (with **Import from environment**), ② define models, ③ assign at least `reasoning` + `embeddings`, Finish. A redirect guard sends an authed user with no config (no doc, or empty `reasoning`/`embeddings`) to `/onboarding`; other pages stay reachable but AI-dependent bits show "configure in Settings."

**New deps:** `@ai-sdk/anthropic`, `@vueuse/integrations` + `sortablejs`.

## 7. Errors

Typed: `AiNotConfiguredError(usage)`, `AiAllFailedError(usage, attempts[])`, `ConfigValidationError`. Voice already surfaces pipeline errors as `{type:'error'}`; other consumers surface the typed message. Test-provider and dim-probe return structured results, not throws-to-client.

## 8. Testing

- **Unit (vitest):**
  - zod schema: valid doc parses; dangling `providerId`/model-id rejected; can't-delete-referenced rejected.
  - crypto: encrypt→decrypt roundtrip; tamper → auth-tag failure; `redactDoc` emits no ciphertext + correct `hasKey`.
  - resolver: `resolveChain` ordered + decrypted; empty → `AiNotConfiguredError`; embeddings chain filtered to 2560.
  - `withFailover`: primary throws → fallback used; all throw → `AiAllFailedError` with attempts; success short-circuits.
  - `languageModel`: anthropic vs openai-compatible dispatch (mocked adapters).
  - redaction guard: `GET` handler output contains no `apiKeyEnc`.
- **E2E (playwright-cli):** `/settings` add provider (key write-only), define model, assign + drag-reorder persists across reload; fresh-state redirects to `/onboarding`.
- **Migration:** a Drizzle migration adds the `settings` table; full suite stays green.

## 9. Scope / YAGNI

- No per-request model switching beyond the existing voice picker (broader runtime switching is a later add).
- No embedding re-index / dimension change (pinned 2560).
- In-process cache only (single instance; no cross-process invalidation).
- No provider health dashboards or cost/usage tracking.
- **Export/Import YAML deferred** — the JSONB document makes it a trivial later add (the portability/emergency-edit win of a file without it being the source of truth).

## 10. Docs to update on ship

- `docs/DEPLOYMENT.md` — env table shrinks to infra-only; document onboarding + the optional `CONFIG_ENC_KEY`.
- `docs/wiki/ai-providers.md` — rewrite around the registry.
- `docs/wiki/` — new page for the settings/config system if warranted.
- New handover in `docs/handovers/`; roadmap entry.
