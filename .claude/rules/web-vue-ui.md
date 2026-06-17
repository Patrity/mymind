---
paths:
  - "app/**/*.vue"
---

# Vue / Nuxt UI components

When editing any `.vue` file:

- **Use Nuxt UI components, not hand-rolled markup.** Reach for `U*` components (`UButton`, `UCard`, `UModal`, `UInput`, `UForm`, `USelect`, `UTooltip`, …) before writing raw `<div>`/`<button>` + Tailwind. Compose UIs out of Nuxt UI primitives.
- **Invoke the `nuxt-ui-docs` skill before using or changing a component.** Our installed Nuxt UI is **v4** and your training-data knowledge of its props/slots/variants is stale. Use the `nuxt-ui-templates` skill when you need a composition or layout pattern (dashboard, form, chat, settings, …).
- **Color: semantic design tokens only — never raw Tailwind palette classes.**
  - Use the color aliases: `primary`, `secondary`, `success`, `info`, `warning`, `error`, `neutral` (e.g. `color="primary"`, `text-primary`, `bg-error/10`).
  - Use the surface/text tokens: `text-default`, `text-muted`, `text-dimmed`, `text-toned`, `text-highlighted`, `bg-default`, `bg-muted`, `bg-elevated`, `bg-accented`, `border-default`, `border-muted`, `border-accented`.
  - **Do NOT** write generic palette classes like `text-gray-200`, `slate-*`, `zinc-*`, `bg-purple-600`. The theme maps `primary → gold`, `secondary → thunder`, `info → thunder`, `neutral → panel` in `apps/web/app/app.config.ts` (success/warning/error keep Nuxt UI defaults); reference the alias so a theme change propagates. The brand ramps `gold-*`/`panel-*`/`thunder-*` (defined in `main.css`) are allowed on **brand surfaces** (landing, the `Tw*` components) but prefer aliases elsewhere. If unsure of a token name, confirm via `nuxt-ui-docs`.
- **Validate UI work with `playwright-cli`, NOT the Playwright MCP.** Green typecheck/test/build do not catch rendering/wiring bugs — prove the change in the browser. **Invoke the `browser-testing` skill** for the how-to: the dev test credentials, logging into auth-gated pages, the snapshot→ref→click workflow, the reka-ui real-click rule (`UTabs`/`USelectMenu`/`USwitch` need a real `click <e-ref>`, not `el.click()`), the authenticated `eval`+`fetch` fixture/assert pattern, and the stale-`.vue`-HMR gotcha.
