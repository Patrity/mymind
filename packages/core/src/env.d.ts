// `import.meta.dev` is a build-time define: Nitro/Vite replace it with true in `nuxt dev` and
// false in `nuxt build`. Outside a Nitro build (vitest, tsx scripts, the step-2 worker) it is
// simply undefined — so the one reader (lib/observability/email.ts, the RESEND_FAKE dev stub)
// stays disabled there. Declared here because core's standalone typecheck has no Nitro types.
interface ImportMeta {
  readonly dev?: boolean
}
