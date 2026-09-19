---
paths:
  - "app/**/*.ts"
  - "app/**/*.vue"
  - "nuxt.config.ts"
---

# Nuxt framework conventions

Working anywhere in the web app:

- **Invoke the `nuxt-docs` skill** before using Nuxt composables (`useFetch`, `useAsyncData`, `useState`, `useRuntimeConfig`, `navigateTo`, …), configuring modules, or touching routing / middleware / Nitro server routes. We run **Nuxt 4**; don't guess composable signatures or config keys from memory.
- **Nuxt 4 layout:** app code lives under `apps/web/app/` (the `srcDir`) — `composables/`, `components/`, `pages/`, `middleware/`, `lib/`, `assets/`. Server/Nitro routes live under `apps/web/server/`. Follow the existing structure rather than inventing new top-level dirs.
- **Secrets come from `runtimeConfig`** (`useRuntimeConfig()`), never `process.env` directly in app code. Server-only secrets stay off the `public` key.
- **Production builds at a 4096 MB heap** (`deploy.yml`: `NODE_OPTIONS=--max-old-space-size=4096`; CI uses the V8 default). Client-bundle weight is what pushes it over: a dependency that registers hundreds of lazy chunks OOMs `pnpm build` in the Nitro phase. Never import `createHighlighter`/`codeToHtml` from bare `shiki` in client code — use `shiki/core` + `shiki/engine/javascript` with explicit `shiki/langs/*` / `shiki/themes/*` imports (see `app/components/ai-elements/code-block/utils.ts`). When adding a UI dependency, compare `.output/public/_nuxt/*.js` count + gzip total before/after and build once at 4096 MB.
