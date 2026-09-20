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
- **A `nitro.publicAssets` `baseURL` PREFIX-matches, so it can swallow `public/` siblings.** We serve
  `vad`, `ort` and `rive` from package dirs that way (`nuxt.config.ts`). A new `public/rive-personas/`
  404'd every file because `/rive-personas/…` matched the `rive` handler and was looked up inside the
  `@rive-app` package — while an identical file in any other subdirectory served fine (cycle 65; renamed
  to `public/persona-riv/`). Typecheck, tests and the build all stay green, so **curl the asset path
  against a dev server** after adding anything under `public/` whose first segment shares a prefix with
  one of those `baseURL`s.
- **Secrets come from `runtimeConfig`** (`useRuntimeConfig()`), never `process.env` directly in app code. Server-only secrets stay off the `public` key.
- **Production builds at a 4096 MB heap** (`deploy.yml`: `NODE_OPTIONS=--max-old-space-size=4096`; CI uses the V8 default). Never import `createHighlighter`/`codeToHtml` from bare `shiki` in client code — use `shiki/core` + `shiki/engine/javascript` with explicit `shiki/langs/*` / `shiki/themes/*` imports (see `app/components/ai-elements/code-block/utils.ts`). When adding a UI dependency, compare `.output/public/_nuxt/*.js` count + gzip total before/after and build once at 4096 MB — success is `.output/server/index.mjs` existing + "Build complete!", not an exit code (`/usr/bin/time` has reported 0 on an OOM).
  - **A "Nitro phase" OOM is usually memory pinned from the Vite builds, not Nitro's own work.** `@tailwindcss/vite` pinned the client + SSR Rollup graphs into Nitro (2.8 GB of live heap → 0.7 GB once `modules/tailwind-build-context.ts` unpinned them; cycle 65). Keep that module; if it warns "not found or reshaped" after a Tailwind/Vite/Nuxt upgrade, fix it first. Diagnose with **live** heap, not RSS or chunk counts: `node --trace-gc --max-old-space-size=4096 node_modules/nuxt/bin/nuxt.mjs build` (NODE_OPTIONS rejects `--trace-gc`) and read each `Mark-Compact … -> N MB`; retainers come from a heap snapshot (`v8.writeHeapSnapshot()` in a throwaway local module). The prod buildDir is `node_modules/.cache/nuxt/.nuxt`, not `.nuxt`.
