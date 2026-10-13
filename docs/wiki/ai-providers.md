---
title: AI Model Providers
status: shipped
cycle: 72 (`subagents` model class + per-model pools: cycle 83; `judge` usage: cycle 84)
updated: 2026-10-12
mymind_id: fcdcdbb4-a794-4642-9cc7-379e57e93f58
mymind_hash: fd1bbd2e597e84ac57506d4b00c26f6ac6a01da9d2dd807d7280b6f816d00d00
---

# AI Model Providers

Model access is **DB-backed and runtime-editable** via the AI config registry. Providers, models, and per-usage failover chains live in one JSONB document; the `/settings/*` pages and `/onboarding` wizard edit it; the resolver decrypts keys and merges provider+model into ready-to-call chains. **Swapping or adding a model is a UI change, never code, never an env redeploy.** The old `AI_*` env vars are now import-only seeds (see Migration below).

## The config document (`packages/core/src/lib/ai/registry/types.ts`)

One JSONB row: `settings.key = 'ai_config'`, value = `AiConfigDoc`:

```ts
interface AiConfigDoc {
  version: 1
  providers: ProviderDef[]   // { id, name, kind, baseURL, apiKeyEnc }
  models:    ModelDef[]      // { id, providerId, modelId, label, dim, description, maxInFlight }
  assignments: Record<Usage, string[]>  // usage -> ordered model ids (failover priority)
}
```

- **`USAGES`** = `reasoning` · `bulk` · `embeddings` · `vision` · `stt` · `tts` · `rerank` · `jev` *(cycle 72)* · `subagents` *(cycle 83 — see below)* · `judge` *(cycle 84 — see below)*.
  - **`jev`** is TypeSafe System One — a decision model, not a chat completion, so it does NOT go through `withFailover` (no fallback chain; unconfigured or unreachable simply means memories go unscored). It is in `USAGES` anyway because everything it needs — baseURL, apiKey, a model id — is what a ProviderDef + ModelDef already carry, and the whole registry (zod schema, PUT validation, the assignments UI) is generated from this array. Keeping its key in an env file instead would have made it the one model secret not editable from Settings. See [memory.md](memory.md#jev-scoring-a-second-opinion-cycle-72).
  - Assign it the model id **`jev-latest`**: the API echoes back which version actually answered, and `memories.jev_model` stores that, so upgrades arrive automatically without losing per-row provenance.
- **`ProviderDef.kind`** is always **`openai-compatible`** (baseURL required). There is **one transport** — non-OpenAI vendors (e.g. Anthropic/Claude) are fronted by an **OpenAI-compatible gateway (LiteLLM)** and configured as a normal `openai-compatible` provider whose baseURL points at the gateway. (Native `anthropic` support and the `@ai-sdk/anthropic` dependency were removed in cycle 21 — see the handover — because the two transports diverged: Anthropic worked on the agent's `languageModel()` path but silently broke on the `chat()` path.) `apiKeyEnc` is AES-GCM ciphertext, **server-only — never serialized to the client.**
- **`ModelDef.dim`** is `EMBEDDING_DIM` (2560) for embedding models, else `null`.
- **`ModelDef.description`** (cycle 83, nullable, ≤ 500 chars, trimmed, blank → `null`) and
  **`ModelDef.maxInFlight`** (cycle 83, nullable int, bounds 1–256 — `MAX_IN_FLIGHT_LIMITS`): see
  `subagents` below. Both default `null` on an older stored doc or PUT body, so neither field can
  make a config written before cycle 83 fail to parse.
- ⚠️ **Adding a usage must never invalidate an existing config.** Every key in `assignments` is `.default([])` in BOTH the stored-doc schema (`registry/schema.ts`) and the PUT validator (`api/settings/ai-config.put.ts`). When they were required, adding `jev` made every config written before it existed fail to parse — and a parse failure surfaces as *"AI not configured"*, so the entire provider and model set appears to vanish and the app redirects to `/onboarding`. A usage nobody has assigned is legitimately empty, so defaulting is also the honest reading. Covered by `test/ai-registry-schema.test.ts`.
- **`assignments[usage]`** is an *ordered* list of model ids = the failover chain for that usage (first = primary).

## Storage + encryption

- **`store.ts`** — `loadConfig()` / `saveConfig()` / `invalidate()`. Persists the single `ai_config` row (`onConflictDoUpdate`) with an in-process module-level cache (single instance, so explicit invalidation is enough). Reads/writes re-validate through the Zod schema.
- **`crypto.ts`** — `encryptSecret()` / `decryptSecret()`, AES-256-GCM. Stored format: `base64(iv(12) | tag(16) | ciphertext)`. The 32-byte key is taken from `CONFIG_ENC_KEY` (raw 32-byte base64) **when set**; otherwise it is **derived from `BETTER_AUTH_SECRET` via HKDF-SHA256** (fixed salt `mymind-ai-config`, info `ai-config-key`) — so no new required env. If neither `CONFIG_ENC_KEY` nor `BETTER_AUTH_SECRET` is set, encryption throws. A bad `CONFIG_ENC_KEY` (not 32 bytes) also throws.
- **`schema.ts`** — Zod `docSchema` with a `superRefine` for referential integrity (no FKs in a JSONB doc): every model references an existing provider, every assignment references an existing model, `openai-compatible` providers must have a baseURL. `redactDoc()` produces the client-safe view: provider `apiKeyEnc` is stripped and replaced with a boolean `hasKey`; models + assignments pass through unchanged.

## Resolver — `packages/core/src/lib/ai/registry/resolve.ts`

- **`resolveChain(usage)`** (cached) / **`resolveChainFrom(doc, usage)`** (pure) — builds the ordered, **decrypted** `ResolvedModel[]` chain: walks `assignments[usage]`, joins each model to its provider, decrypts the key. For `embeddings` it filters the chain to dim-2560 models only (you can't fail over to a different embedding dimension). Throws `AiNotConfiguredError` if the chain is empty.
- **`withFailover(usage, fn)`** / `withFailoverOver(...)` — runs `fn` against each `ResolvedModel` in order until one succeeds; throws `AiAllFailedError` with per-attempt errors if all fail. **Failover is throw-driven**: `fn` must `throw` to advance to the next model — returning a sentinel/empty value reads as success and strands the call on a broken provider. The text helper `chat()` (`packages/core/src/lib/ai/chat.ts`) enforces this via `extractContent()`, which **throws** when the response has no usable assistant content (missing `choices`, empty string, or a non-JSON body such as an HTML error page returned with HTTP 200). *(This is what masked a misconfigured provider in cycle 21: a 200 + HTML body returned `''`, looked like success, and never failed over.)* **Cancellation is the one exception to throw-driven failover**: an `AbortError` means the *caller* walked away (barge-in, a newer utterance, a closed socket), so the chain stops immediately and the **original** error is rethrown — never wrapped in `AiAllFailedError`. Wrapping it defeated the `err.name === 'AbortError'` guards in `voice/orchestrator.ts` + `voice/ws.ts`, which shipped a bogus "all models failed" error frame to the client and logged 2 unacked errors on every barge-in.
- **`languageModel(m)`** — builds a `createOpenAICompatible` AI SDK model (single transport; all providers are OpenAI-compatible). Consumers (reasoning/bulk/vision LLM roles, embeddings, etc.) call `withFailover` rather than touching env.

## `subagents` model class and per-model pools (cycle 83)

Spec: [`2026-10-12-coordinator-design.md`](../superpowers/specs/2026-10-12-coordinator-design.md) §3.
Consumed by the [Coordinator](workstreams.md#coordinator-cycle-83) (child workstreams pick their
model from this list) and the worker's claim path (every workstream segment, coordinators
included, acquires a pool slot before it runs — see [agent-runtime.md](agent-runtime.md)).

### The list

`subagents` is an **ordered, capability-described** model list, same shape as every other usage's
`assignments[usage]` — a list of model ids — but read differently: a coordinator picks a model
**by label**, not by failover order. Settings → Model Configuration shows it like any other
assignment chain (draggable order), filtered to exclude embedding models
(`AssignmentsTab.vue`); each model's own page (Settings → Models) carries its new `description`
and `maxInFlight` fields (`ModelForm.vue` — a blank description saves `null`; an out-of-range
`maxInFlight` shows an inline "Must be a whole number from 1 to 256 (or empty for the default)."
error with no silent clamping, and the server 422s the same input).

- `listSubagentModels()` (`registry/resolve.ts`) returns `{ label, description, maxInFlight }[]` in
  `subagents` order — `maxInFlight` resolved to `DEFAULT_MAX_IN_FLIGHT` when unset. This is what
  `spawn_workstreams`'s description shows the model, rebuilt fresh per segment so an edit in
  Settings takes effect on the coordinator's very next spawn call.
- **Save-time validation** (`subagentsProblems`, PUT-only — deliberately **not** in `parseConfig`,
  so a rule added later can never make an existing stored config unreadable): `subagents` may not
  contain two models under the same label (the coordinator picks by label, so a duplicate would be
  unreachable) or any embedding model (`dim` set — it can't run an agent turn). Both 422 with a
  message naming the model/label; nothing is saved if either fires.

### Resolution order

A child's failover chain (`resolveSubagentChainFrom(doc, label?)` — pure; cached as
`resolveSubagentModel`):

1. the `subagents` model labelled `label` (when a label was given and spawn validated it exists);
2. the rest of `subagents`, in list order;
3. the whole `reasoning` chain.

No label given → the **first** `subagents` entry is the implicit default. Empty `subagents` →
children run the `reasoning` chain alone. A model appearing in both lists is tried **once**, at its
earliest position. A label removed from `subagents` after a child was spawned with it falls back
to the same resolution as no label (the default), rather than failing every one of that child's
segments — `spawn_workstreams` itself still refuses an unknown label up front. Coordinators
(top-level workstream segments) always run on `reasoning`, never `subagents`.

### Per-model pools

Every **workstream segment** (chat turns and headless wakes excluded — chat stays responsive) must
acquire a slot in its **primary model's** pool before the worker claims it:

- A pool isn't a structure held in memory — it's the **count of `running` `agent_runs` rows** with
  `kind='workstream'` and that `model_def_id`, checked in `claimNextRun`'s own query
  (`runtime/runs.ts`) against the model's `maxInFlight` (or `DEFAULT_MAX_IN_FLIGHT` = **6** when
  unset or the model isn't in the config — e.g. deleted since the segment was queued). A slot frees
  the instant a run leaves `running` (done, failed, aborted, or recovered as `interrupted`), and a
  worker restart recomputes nothing: the rows ARE the pool.
- A segment over the limit simply stays `queued`, claimed oldest-first (FIFO) when a slot frees.
- Every claim takes one global advisory lock (`mymind:agent_runs:claim`) around the read-then-write
  pool check, so two concurrent claimers can never both see — and take — the last free slot.
- The pool key is the segment's **primary model**, stamped onto `agent_runs.model_def_id` once,
  when the segment is **enqueued** (`workstreams/loop.ts enqueueSegment` → `segmentPrimaryModelId`
  in `runtime/pools.ts`) — never rewritten during the run. Failing over to a different model
  mid-segment therefore does **not** take a second pool slot (bounded overshoot on the fallback
  model; accepted by spec §3). `segmentPrimaryModelId` returns a child's `childChainFrom` head (its
  label, else the first `subagents` model, else `reasoning`'s head) for a child, and the
  `reasoning` head for everything else, including coordinators. The runner builds the segment's
  actual model chain (`model.ts agentChain`) from the SAME function, so the slot a segment took and
  the model it tries first are always identical (final fix wave C2's underlying guarantee, carried
  from Task 2).
- `poolLimits()` reads the cached AI config and maps model id → `maxInFlight`; an unreadable config
  never blocks claiming — every model just gets the default.

### Default `maxInFlight` and the ramp

`DEFAULT_MAX_IN_FLIGHT = 6` (`registry/types.ts`), measured against the dev `reasoning` head (Qwen
3.8 Flash Next) over LiteLLM, `scripts/vllm-ramp.ts` (concurrent streaming waves, fixed prompt, 256
max tokens, TTFT p95 cutoff 10 s):

| Concurrent streams | TTFT p50 (s) | TTFT p95 (s) | Aggregate tok/s |
|---|---|---|---|
| 1 | 0.23 | 0.23 | 70.5 |
| 2 | 0.36 | 0.37 | 121.6 |
| 4 | 0.37 | 0.37 | 216.7 |
| 8 | 0.89 | 0.89 | 351.9 |
| 10 | 0.39 | 4.54 | 286.6 |
| 16 | 0.46 | 5.58 | 364.5 |
| 24 | 5.05 | 11.10 | 354.0 |

**Knee between 8 and 10**: up to 8 concurrent streams every request starts in under 1 s and
aggregate throughput peaks (~370 tok/s) — the server batches ~8 sequences. From 10 on, later
requests queue a whole generation (4.5–5.5 s) for a server slot, with no further aggregate gain.
The shipped default of **6**, not 8, deliberately sits *below* that knee (ruling C1): with a
model's pool full (6 running segments), there are still ~2 sequences of headroom on the same model
for unpooled chat turns. Tony can set a lower per-model `maxInFlight` (e.g. 3) to free more
headroom, or raise it per model once a second GPU/model exists.

## `judge` usage (cycle 84)

`judge` is an ordinary chat-completion usage with an ordinary failover chain — empty assignment →
falls back to the `reasoning` chain (self-consistency, no separate model required). Two consumers
share it, both through `resolveJudgeChain()`/`withFailoverOver('judge', ...)`:

- **The approval judge** (`judge/verdict.ts`) — one bounded, tool-free, schema-constrained call per
  approval card: a risk/recommendation/confidence verdict on the specific action.
- **The output guard** (`judge/guard.ts`) — one classification call on untrusted tool output (web,
  mail, workspace, child) when the heuristic router says it's worth asking: `{ injection, confidence,
  reasons }`.

Both call `languageModel(m, { structuredOutputs: true })`, which sends `response_format:
json_schema`; a provider that answers but rejects the schema is still read leniently from its text
reply (never auto-approvable when recovered that way). The `AssignmentsTab` picker for `judge`
(like `subagents`) excludes embedding models — a `dim !== null` model can't run a chat completion.

**Not an AI-config field**: how many judge/guard calls may run at once in one worker process is
`judge.maxInFlight` (default 4, range 1–16) — a **separate** setting, stored in the `agent_settings`
doc (`judge/limiter.ts`'s FIFO semaphore), not in this registry's per-model pools. Full reference:
[judge.md](judge.md).

## Endpoints (`server/api/settings/`)

| Method + path | Does |
|---|---|
| `GET /api/settings/ai-config` | Redacted read — returns `redactDoc(loadConfig())`. Provider keys appear only as `hasKey: boolean`. |
| `PUT /api/settings/ai-config` | Validates + saves the whole doc. Keys are write-only: each provider's `key` field is `{apiKey}` (encrypt new), `{keep:true}` (reuse stored ciphertext by id), or `null` (clear). **Blanket 422** on any invalid body (raw shape OR referential). If embeddings are assigned, runs a **dim-probe** against the primary embedding model's `/embed` (`{inputs:['probe']}`, 15s timeout) and 422s unless it returns exactly 2560 dims — so you can't save an unreachable or wrong-dimension embedding model. *(Cycle 83)* also 422s on `subagentsProblems(doc)`: a duplicate label within `subagents`, or an embedding model listed in `subagents` — each named in the error. |
| `POST /api/settings/test-provider` | Reachability + auth check: `GET {baseURL}/models` with the bearer key. Accepts inline (not-yet-saved) form config, or reuses a stored key by `id`. Returns `{ ok, message: "HTTP <status>" }`. |
| `POST /api/settings/import-env` | One-time onboarding seed from leftover `AI_*` env (see Migration). **422s if a config already exists** (non-empty registry) — it is a one-time seed only, so it can't blow away a populated `ai_config` row. |

## UI

### `/settings/*` — `app/pages/settings.vue` parent shell + subpages

`app/pages/settings.vue` is a thin parent shell (`UDashboardPanel` + `UDashboardNavbar`, renders `<NuxtPage />` in the body); each child under `app/pages/settings/` is a ~7-line wrapper around one `Settings*Tab` component and sets `definePageMeta({ title })`, which the parent reads to build the navbar title `Settings · <page>`. The three AI-config pages:

1. **Providers** (`/settings/providers`, `SettingsProvidersTab.vue` / `ProvidersTab.vue` + `ProviderForm.vue`) — CRUD over providers. Every provider is `openai-compatible`, so the form is name + base URL + key (no kind selector). Key field is **write-only** (you set or clear it, you never read it back); a **Test** button calls `test-provider`.
2. **Models** (`/settings/models`, `SettingsModelsTab.vue` / `ModelsTab.vue` + `ModelForm.vue`) — CRUD over models (provider + literal `modelId` + label). An embedding toggle sets `dim = 2560`.
3. **Model Configuration** (`/settings/model-config`, `SettingsAssignmentsTab.vue` / `AssignmentsTab.vue` + `AssignmentChain.vue`) — per-usage **draggable failover chains** (drag to reorder priority) via `@vueuse/integrations/useSortable` + sortablejs. The embeddings chain's model dropdown is filtered to dim-2560 models.

State flows through **`app/composables/useAiConfig.ts`** — a shared `useState` editable draft with `load()` / `save()` (PUT the whole doc) / `testProvider()` / `importEnv()` and provider/model/assignment CRUD. Keys are tracked client-side as: existing untouched → `{keep:true}`, typed → `{apiKey}`, cleared → `null`. Settings pages are a collapsible nested group in the main sidebar (`app/layouts/default.vue` `mainItems`), auto-open on `/settings/*`; `/settings` redirects to `/settings/providers`.

### `/onboarding` — first-run gate

- **`app/middleware/onboarding.global.ts`** — after auth, redirects to `/onboarding` until configured. Exempts `/login`, `/onboarding`, and `/share/**`.
- **`app/composables/useAiConfigStatus.ts`** — cached `needsOnboarding`, true until **both** `reasoning` AND `embeddings` have ≥1 assigned model.
- **`app/pages/onboarding.vue`** — a `UStepper` wizard reusing the three settings tabs, plus an **"Import from environment"** button (loading + error feedback) that calls `import-env`. **Finish** is gated on reasoning+embeddings being assigned → saves → refreshes status → navigates home.

## Migration — `AI_*` env vars are now import-only

Older builds configured each role through `AI_<ROLE>_BASE_URL` / `_API_KEY` / `_MODEL` env vars resolved at runtime by an `aiProvider()` factory. That env-driven runtime config has been **replaced** by the registry. The `AI_*` vars now have exactly one job: a **one-time onboarding seed**, consumed only by the Import button when the config is empty.

`POST /api/settings/import-env` (`import-env.post.ts`) reads `process.env` directly, maps the old roles → usages (`AI_REASONING`→reasoning, `AI_BULK`→bulk, `AI_EMBEDDINGS`→embeddings (dim 2560), `AI_VISION`→vision, `AI_STT`→stt, `AI_TTS_KOKORO` + `AI_TTS_CHATTERBOX`→tts, `AI_RERANK`→rerank), dedupes providers by baseURL, encrypts keys, and saves. It builds from `emptyDoc()` and writes the whole `ai_config` row, so to protect a populated config it now **422s if a config already exists** — it is a strictly one-time seed for an empty registry, surfaced only via the onboarding Import button, not a merge. After onboarding, the `AI_*` vars do nothing at runtime; all model config lives in the DB and is edited in `/settings`.
