---
title: AI Config Registry (DB-backed providers/models + settings UI + onboarding)
cycle: 12
date: 2026-06-10
status: shipped
spec: ../superpowers/specs/2026-06-10-ai-config-registry-design.md
plan:
  - ../superpowers/plans/2026-06-10-ai-config-registry-backend.md
  - ../superpowers/plans/2026-06-10-ai-config-registry-ui.md
wiki: ../wiki/ai-providers.md
shipped:
  - "server/lib/ai/registry/types.ts — USAGES (reasoning/bulk/embeddings/vision/stt/tts/rerank), EMBEDDING_DIM=2560, ProviderDef/ModelDef/AiConfigDoc/ResolvedModel, emptyDoc()/emptyAssignments(). The persisted doc is one JSONB row (settings.key='ai_config')."
  - "server/lib/ai/registry/crypto.ts — AES-256-GCM encryptSecret/decryptSecret; key from CONFIG_ENC_KEY (raw 32-byte base64) when set, ELSE derived from BETTER_AUTH_SECRET via HKDF-SHA256 (fixed salt/info). Stored format base64(iv(12)|tag(16)|ct)."
  - "server/lib/ai/registry/store.ts — loadConfig/saveConfig/invalidate; persists the single ai_config row (onConflictDoUpdate) with an in-process module-level cache (single instance). Re-validates on read and write."
  - "server/lib/ai/registry/schema.ts — Zod docSchema + superRefine referential integrity (model→provider, assignment→model, openai-compatible needs baseURL); redactDoc strips apiKeyEnc → hasKey boolean (no ciphertext ever leaves the server)."
  - "server/lib/ai/registry/resolve.ts — resolveChainFrom (pure) / resolveChain (cached) build the ordered DECRYPTED ResolvedModel[] failover chain per usage; embeddings chain filtered to dim-2560 only; withFailover runs fn against each model until one succeeds; languageModel() kind-aware AI SDK builder (createAnthropic vs createOpenAICompatible)."
  - "server/lib/ai/registry/errors.ts — AiNotConfiguredError / AiAllFailedError."
  - "server/api/settings/ai-config.get.ts — redacted read (redactDoc(loadConfig()))."
  - "server/api/settings/ai-config.put.ts — validates + saves the whole doc; per-provider key field {apiKey}|{keep:true}|null (encrypt new / reuse stored ciphertext by id / clear); BLANKET 422 on any invalid body (raw shape OR referential); embeddings dim-probe against the primary model's /embed (15s timeout) — 422 unless exactly 2560 dims."
  - "server/api/settings/test-provider.post.ts — reachability+auth ping (anthropic → api.anthropic.com/v1/models with x-api-key; openai-compatible → {baseURL}/models); inline form config or stored key by id; returns {ok, message:'HTTP <status>'}."
  - "server/api/settings/import-env.post.ts — one-time onboarding seed: reads process.env directly, maps AI_REASONING/BULK/EMBEDDINGS/VISION/STT/TTS_KOKORO/TTS_CHATTERBOX/RERANK → usages, dedupes providers by baseURL, encrypts keys, saves, returns redacted doc."
  - "app/composables/useAiConfig.ts — shared useState editable draft; load()/save() (PUT whole doc)/testProvider()/importEnv(); provider/model/assignment CRUD. Keys write-only client-side (existing→{keep:true}, typed→{apiKey}, cleared→null)."
  - "app/composables/useAiConfigStatus.ts — cached needsOnboarding, true until reasoning AND embeddings each have ≥1 assigned model."
  - "app/middleware/onboarding.global.ts — after auth, redirect to /onboarding until configured; exempts /login, /onboarding, /share/**."
  - "app/components/settings/ProviderForm.vue + ProvidersTab.vue — provider CRUD; write-only key field; Test button; anthropic kind forces baseURL=null."
  - "app/components/settings/ModelForm.vue + ModelsTab.vue — model CRUD; embedding toggle sets dim=2560."
  - "app/components/settings/AssignmentsTab.vue + AssignmentChain.vue — per-usage draggable failover chains via @vueuse/integrations/useSortable + sortablejs; embeddings dropdown filtered to dim-2560 models."
  - "app/pages/settings.vue — UDashboardPanel + UTabs (Providers / Models / Model Configuration). Nav link added to app/layouts/default.vue sidebar."
  - "app/pages/onboarding.vue — UStepper wizard reusing the three tabs; 'Import from environment' button (loading+error feedback); Finish gated on reasoning+embeddings → save → status.refresh → navigate home."
  - "Resolver consumers cut over to the registry: server/lib/agent/model.ts, server/lib/ai/chat.ts, server/lib/ai/embeddings.ts, server/api/voice/ws.ts + voices.get.ts, server/services/memory.ts now resolve from the DB chain (no AI_* runtime env). nuxt.config.ts runtimeConfig.ai removed; docker-compose.prod.yml NUXT_AI_* mapping removed."
  - "New deps: @vueuse/integrations, sortablejs, @types/sortablejs."
  - "RIDER (separate system, shares the sortable dep): app/pages/tasks.vue kanban migrated off raw HTML5 DnD to useSortable shared-group columns (group:'tasks'); one sortable per column bound to a per-column mutable array (shallowReactive colRefs + watchElement:true so binding survives the loading-skeleton v-if/v-else remount); cross-column drop → moveTask + loadTasks (server-authoritative reconcile), same-column reorder = no persistence. E2E PASS (drag Todo→In Progress persisted across reload; click-to-edit still works)."
  - "docs/wiki/ai-providers.md — rewritten around the registry (current behavior). docs/DEPLOYMENT.md — env table shrunk to infra-only; AI_* documented as import-only seeds; CONFIG_ENC_KEY + onboarding flow documented; §14a model-resolution note corrected to the registry."
verified:
  - "pnpm typecheck: PASS (green across all tasks)."
  - "pnpm build: PASS (.output produced, green across all tasks)."
  - "Live E2E (playwright-cli, against the real homelab rigs): PASS. Authed nav → /onboarding redirect; provider Test → 'Reachable'; Import-from-environment seeded 6 providers / 7 models from .env (bulk deduped onto the reasoning rig); drag-reorder of the tts chain; Finish → embeddings dim-probe against the live TEI rig (:8882) returned 2560 → saved → landed home (no onboarding bounce); GET /api/settings/ai-config returned hasKey booleans with NO ciphertext; reorder persisted across a /settings reload (tts = chatterbox→kokoro)."
  - "Two bugs found AND fixed during E2E (commit 758f681): (1) AssignmentsTab referenced bare <AssignmentChain> but Nuxt auto-imports it dir-prefixed as <SettingsAssignmentChain>, so the chains never rendered (typecheck does not catch unresolved template component names); (2) the useSortable onEnd callback read the local list before vueuse finished mutating it, emitting the pre-drop order so dragged rows snapped back — now emits from a deep watch on list, guarded against the prop-resync echo."
deferred:
  - "Per-request model switching beyond voice — the resolver supports failover chains per usage, but there is no UI/API to pick a specific model per individual request (e.g. per chat message) outside the voice path."
  - "Embedding reindex on model change — swapping the embeddings model does not re-embed existing documents; the dim-probe enforces 2560 so vectors stay compatible, but a model swap to a different (still-2560) embedder leaves old vectors as-is. No reindex worker yet."
  - "Export / import YAML — config is edited only via the UI + the one-time AI_* import. No round-trippable config export/import for backup or moving between instances."
known_considerations:
  - "import-env overwrites the whole ai_config row: import-env.post.ts builds from emptyDoc() and saves the result, so it REPLACES (not merges) any existing config. It is a one-time seed for an empty config, surfaced only via the onboarding Import button."
  - "Embeddings dim-probe requires a reachable 2560-dim endpoint on SAVE: PUT /api/settings/ai-config 422s if the primary embedding model's /embed is unreachable or returns != 2560 dims. You cannot finish onboarding (or save an embeddings assignment) without the TEI rig reachable."
  - "CONFIG_ENC_KEY fallback: if unset, the encryption key is derived from BETTER_AUTH_SECRET via HKDF — so existing deploys need no new env. But rotating BETTER_AUTH_SECRET would make stored provider keys undecryptable (resolveChain swallows the decrypt error → null apiKey → provider calls fail auth). Set CONFIG_ENC_KEY explicitly to decouple."
---

# Cycle 12 — AI Config Registry (handover)

Replaced env-var-only AI model config (`AI_<ROLE>_*` resolved by an `aiProvider()` factory) with a **DB-backed registry**: providers, models, and per-usage failover chains live in one JSONB document, edited in-app at `/settings`, gated by an `/onboarding` first-run wizard. Provider API keys are encrypted at rest. Swapping or adding a model is now a UI change — no redeploy, no env edit.

This branch shipped in two plans:

- **Plan 1 (server, committed before this session):** the `server/lib/ai/registry/` module (types/crypto/store/schema/resolve/errors) and the three endpoints (`GET`/`PUT /api/settings/ai-config`, `POST /api/settings/test-provider`). It also cut the resolver consumers over and removed `runtimeConfig.ai` + the compose `NUXT_AI_*` mapping.
- **Plan 2 (this session):** the UI + onboarding — `useAiConfig` / `useAiConfigStatus` composables, the `onboarding.global` middleware, the settings/onboarding pages, the three tabs (Providers / Models / Model Configuration), and the `import-env` one-time seed endpoint.

## Architecture

**One JSONB doc.** `settings.key = 'ai_config'` holds `{ version:1, providers[], models[], assignments }`. No FK tables — referential integrity is enforced by a Zod `superRefine` (model→provider, assignment→model, openai-compatible→baseURL). The store keeps an in-process cache (single instance) invalidated on every write.

**Encrypted keys, redacted reads.** Provider keys are AES-256-GCM ciphertext (`apiKeyEnc`), server-only. `redactDoc()` replaces them with `hasKey: boolean` so the client never sees ciphertext or plaintext. Writes are write-only: the PUT body's `key` field is `{apiKey}` (encrypt new), `{keep:true}` (reuse stored), or `null` (clear). The encryption key comes from `CONFIG_ENC_KEY` (raw 32-byte base64) when set, else is derived from `BETTER_AUTH_SECRET` via HKDF-SHA256 — no new required env.

**Resolver failover chains.** `assignments[usage]` is an *ordered* list of model ids. `resolveChain(usage)` walks it, joins each model to its provider, decrypts the key, and returns `ResolvedModel[]`. `withFailover(usage, fn)` runs `fn` against each in order until one succeeds. Embedding chains are filtered to dim-2560 models (you can't fail over across embedding dimensions). All AI consumers (reasoning/bulk/vision LLM roles, embeddings, voice STT/TTS, memory) now call the resolver instead of env.

**Onboarding gate.** `needsOnboarding` is true until both `reasoning` and `embeddings` have ≥1 assigned model. The global middleware redirects to `/onboarding` (exempts `/login`, `/onboarding`, `/share/**`) until that holds. The wizard reuses the three settings tabs and offers a one-click "Import from environment" seed.

## Known considerations

- **import-env overwrites the whole row.** `import-env.post.ts` builds from `emptyDoc()` and saves — it REPLACES any existing config, not merges. It's a seed for an empty config, only surfaced via the onboarding Import button.
- **Dim-probe needs a reachable endpoint on save.** `PUT /api/settings/ai-config` probes the primary embedding model's `/embed` and 422s unless it returns exactly 2560 dims. The TEI rig (`:8882`) must be reachable to finish onboarding or save an embeddings assignment.
- **CONFIG_ENC_KEY fallback couples secrets.** Unset = key derived from `BETTER_AUTH_SECRET`. Rotating `BETTER_AUTH_SECRET` then makes stored provider keys undecryptable (`resolveChain` swallows the decrypt error → null key → auth fails downstream). Set `CONFIG_ENC_KEY` explicitly to decouple.

## Follow-ups (2026-06-11)

Five small cycle-12 follow-ups landed on the `feat/cleanup-batch` branch:

- **Onboarding `finish()` guard** — `onboarding.vue`'s `finish()` is now wrapped in try/catch so a save/probe rejection no longer surfaces as an unhandled promise rejection.
- **`save()` → status refresh** — `useAiConfig.save()` now refreshes the cached `useAiConfigStatus` (`needsOnboarding`) after a successful PUT, so saving an assignment from `/settings` clears the onboarding gate without a reload.
- **import-env overwrite guard (422)** — `POST /api/settings/import-env` now **422s when a config already exists** (non-empty registry), making it a strictly one-time seed and closing the destructive whole-doc overwrite noted under Known considerations.
- **Clearer dim-probe message** — the embeddings dim-probe error on `PUT /api/settings/ai-config` no longer wrongly asserts the endpoint is "unreachable" when it responded with the wrong dimension.
- **`EMBEDDING_DIM` dedupe** — the client `2560` literal is deduped into `app/utils/ai-config.ts` (`EMBEDDING_DIM`) instead of a bare magic number in the UI.

## Deferred

- **Per-request model switching beyond voice** — failover chains are per-usage; no per-individual-request model picker outside the voice path.
- **Embedding reindex on model change** — swapping the embeddings model does not re-embed existing docs (dim-probe keeps vectors dimension-compatible, but a swap to a different 2560-dim embedder leaves old vectors as-is). No reindex worker.
- **Export / import YAML** — no round-trippable config export/import; editing is UI-only plus the one-time `AI_*` import.

## Next seam

1. **Merge:** live `playwright-cli` E2E is **green on the box** (onboarding redirect → import/seed → Test → drag-reorder → Finish/dim-probe → persistence + redaction all verified; see `verified`). Two render/drag bugs were found and fixed during it (commit 758f681). Plans 1+2 are ready to merge to master as one unit — never Plan 1 alone. CI auto-deploys master and there is no env fallback, so onboarding must run on first prod boot (the box already has the `AI_*` import seeds + a reachable embeddings rig).
2. **API key management UI (cycle 13)** is the natural next settings surface — same `/settings` shell, CRUD over `api_tokens` (currently insert-by-hand, see DEPLOYMENT §5).
3. If config portability becomes a need, the deferred **YAML export/import** slots cleanly onto `redactDoc` (read) + the existing PUT key-field semantics (write).
