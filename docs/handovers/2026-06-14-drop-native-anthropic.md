---
title: Drop native Anthropic support → single OpenAI-compatible transport (Claude via LiteLLM) + fix failover-defeating empty-response bug in chat()
cycle: 21
date: 2026-06-14
status: shipped
wiki: ../wiki/ai-providers.md
shipped:
  - "server/lib/ai/chat.ts — extracted extractContent(res) which THROWS on an unusable completion (missing choices, empty/whitespace content, or a non-JSON body such as an HTML error page returned with HTTP 200) instead of returning ''. chat() now fetches as unknown and routes through it. This is the actual fix for the reported bug: withFailover only advances on a thrown error, so the old `?? ''` made a broken provider look like success and never failed over. Test: test/ai-chat.test.ts (extractContent shapes + a withFailoverOver integration proving fail-over past an empty/HTML response)."
  - "server/lib/ai/registry/resolve.ts — removed the createAnthropic import and the providerKind==='anthropic' branch in languageModel(); it now always builds createOpenAICompatible. Single transport."
  - "server/lib/ai/registry/types.ts — ProviderKind collapsed to the single member 'openai-compatible' (kept as a union for forward-compat). baseURL comment updated (always the provider/gateway endpoint)."
  - "server/lib/ai/registry/schema.ts — provider kind enum is z.enum(['openai-compatible']). The existing superRefine still requires a baseURL for openai-compatible providers."
  - "server/api/settings/ai-config.put.ts + test-provider.post.ts — kind enums narrowed to ['openai-compatible']; removed the anthropic test branch (the api.anthropic.com/v1/models x-api-key probe). test-provider now always does GET {baseURL}/models with the bearer key."
  - "app/composables/useAiConfig.ts — ProviderKind narrowed to 'openai-compatible' (addProvider already defaulted to it)."
  - "app/components/settings/ProviderForm.vue — removed the kind selector (single kind = no choice) and the anthropic baseURL-nulling watcher; Base URL is always shown/required."
  - "package.json — removed @ai-sdk/anthropic (no longer imported anywhere); lockfile updated via pnpm install."
  - "Config migration (DB, applied to local): scripts/migrate-ai-config-litellm.ts repointed the former anthropic provider (id 1bcee203…) to the LiteLLM OpenAI-compatible gateway (baseURL https://lite.costanzoclan.com/v1, key re-encrypted via encryptSecret), and reordered the reasoning failover chain to [qwen3.6-35b-a3b (local, primary), claude-haiku-4-5 (via LiteLLM, failover)]. Idempotent; validates via parseConfig before writing. REQUIRED because dropping 'anthropic' from the kind enum makes the previously-stored anthropic provider fail parseConfig on load → would break ALL ai resolution app-wide."
deferred:
  - "Anthropic-specific features lost by going through the OpenAI-compatible surface: prompt caching (cache_control breakpoints) and native extended-thinking blocks are not expressed. Not used today (agent runs on qwen; Claude is reasoning failover only). If we later want Claude prompt caching for cost, LiteLLM has params for it but it'd need plumbing."
  - "scripts/migrate-ai-config-litellm.ts is a one-off kept in-tree as a record. Prod/other envs that still have an anthropic-kind provider in their ai_config row must run it (or re-point the provider in /settings) BEFORE deploying this code, or loadConfig() will throw on the stale kind."
  - "The dev server must be restarted to pick up the new code AND clear store.ts's module-level config cache (it still holds the pre-migration doc). Verified the fix against a fresh prod build instead (see below) so the user's running dev session was left untouched."
---

# Drop native Anthropic — cycle 21 follow-up

## The bug (reported)
`[enrichment] parse failed for doc … skipping` repeating every 10 min (the `*/10 * * * *`
`enrich-input` task) for two `/input/` notes. Enrichment had worked before (11 prior
proposals) and the docs themselves were fine.

## Root cause
Two LLM transports that disagreed on what a provider is:
- `languageModel()` (agent path) **was** kind-aware → `createAnthropic` for anthropic providers.
- `chat()` (enrichment/bulk path) was **hardcoded OpenAI-compatible** (`${baseURL}/chat/completions` + Bearer).

The `reasoning` failover chain had **Claude Haiku 4.5 on an `anthropic` provider (baseURL null)**
at position 0. `chat()` built `(''){/chat/completions}` → a *relative* `$fetch`, which Nuxt
answered with its **own SPA HTML shell at HTTP 200**. `chat()` did `res.choices?.[0]?.message?.content ?? ''`
→ returned `''` with **no throw** → `withFailover` treated it as success and **never tried the
working qwen model** at position 1 → `parseProposal('')` → null → "parse failed". Forever, because
no `review_queue` row was inserted so the docs stayed sparse and were re-selected next tick.

Confirmed live: `POST /_nitro/tasks/enrich-input` on the running dev server returned
`{proposed:0, skipped:2}` while the qwen endpoint returned clean JSON for the same content 33/33.

## The fix (per Tony's call: abandon native Anthropic, route Claude via LiteLLM)
One transport everywhere. Claude is now just an `openai-compatible` provider pointed at the
LiteLLM gateway. Plus a defensive `extractContent()` that **throws** on an unusable response so
`withFailover` actually fails over — the bug class disappears regardless of provider.

## Verification (evidence)
- `pnpm test` → **223 passed** (incl. new test/ai-chat.test.ts). `pnpm typecheck` → exit 0. `pnpm build` → exit 0.
- Booted the **production build** on port 3099 (left the dev server alone), minted a temp API token,
  and called the real `POST /api/admin/enrich-run` → **`{proposed:2, skipped:0}`**. Both notes now have
  `pending` review_queue rows with sensible frontmatter (project `thandora`, game-dev tags). Temp token deleted, preview server stopped.
- Both endpoints sanity-checked directly: qwen `:8004` (primary) and `claude-haiku-4-5` via
  `https://lite.costanzoclan.com/v1` (failover) each return clean JSON.

## To apply in the running dev environment
Restart `pnpm dev` (loads the new code + clears the cached ai_config). The next `enrich-input`
tick will then queue the two proposals automatically.
