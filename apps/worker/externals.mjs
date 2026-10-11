// Packages the worker bundle leaves EXTERNAL (build.mjs explains each) — resolved at runtime from the
// release's own node_modules, which stage.mjs fills with exactly these and their dependency closure.
// Each is also a dependency in apps/worker/package.json.
export const EXTERNAL_PACKAGES = ['pg', 'sharp', 'pdf-to-img', 'isomorphic-dompurify', 'better-auth']
// esbuild patterns: + pg's optional native driver (never installed) and better-auth's subpaths.
export const EXTERNAL = [...EXTERNAL_PACKAGES, 'pg-native', 'better-auth/*']
