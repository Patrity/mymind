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
