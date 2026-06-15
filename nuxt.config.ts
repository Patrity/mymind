// https://nuxt.com/docs/api/configuration/nuxt-config
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

// Silero VAD (client barge-in) loads its worklet + ONNX model from `baseAssetPath`
// and the onnxruntime-web WASM from `onnxWASMBasePath`. Under a bundler both default
// to "/" / "./", so the files 404 unless we serve them. Resolve the package dirs
// (robust under pnpm's nested layout) and expose them as static assets at /vad and /ort.
const require_ = createRequire(import.meta.url)
const vadAssetDir = dirname(require_.resolve('@ricky0123/vad-web/package.json')) + '/dist'
const ortAssetDir = dirname(createRequire(require_.resolve('@ricky0123/vad-web/package.json')).resolve('onnxruntime-web'))

export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@nuxtjs/mdc',
    '@vueuse/nuxt'
  ],

  devtools: {
    enabled: true
  },

  // Hybrid rendering: catch-all SPA with SSR carved out for public pages.
  //
  // Mechanism: SSR remains enabled globally (default). routeRules sets ssr:false for
  // every route via catch-all '/**', so new app pages automatically get the SPA shell
  // without needing to be listed explicitly (no pre-login flash or hydration mismatches).
  // /share/** overrides back to ssr:true, which works because the more-specific rule wins.
  //
  // NOTE: Global ssr:false + per-route ssr:true was attempted but does NOT work in Nuxt 4.
  // When ssr:false is set globally the renderer is compiled to always use getSPARenderer()
  // regardless of routeRules — the per-route override only goes the other direction
  // (SSR→SPA via routeRules ssr:false). Verified empirically in preview build.
  // The correct supported hybrid mode is: ssr:true globally + ssr:false per route.

  css: ['~/assets/css/main.css'],

  routeRules: {
    '/': { redirect: '/documents' },
    // Catch-all: every route is SPA by default so new pages never forget.
    '/**': { ssr: false },
    // Public share pages keep SSR for OG/SEO — more-specific rule wins.
    '/share/**': { ssr: true }
  },

  compatibilityDate: '2025-01-15',

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },

  runtimeConfig: {
    databaseUrl: process.env.DATABASE_URL,
    betterAuthSecret: process.env.BETTER_AUTH_SECRET,
    betterAuthUrl: process.env.BETTER_AUTH_URL,
    allowSignup: process.env.ALLOW_SIGNUP,
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 52428800),
    public: {
      // Whether the /login page surfaces a "create account" toggle. Mirrors the
      // server-side disableSignUp gate so the UI only shows what the API allows.
      allowSignup: process.env.ALLOW_SIGNUP === 'true'
    },
    storageDriver: process.env.STORAGE_DRIVER ?? 'local',
    storageLocalDir: process.env.STORAGE_LOCAL_DIR ?? './.data/uploads',
    storageS3: {
      endpoint: process.env.STORAGE_S3_ENDPOINT,
      region: process.env.STORAGE_S3_REGION,
      bucket: process.env.STORAGE_S3_BUCKET,
      accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY
    },
    memoryAutoReviewThreshold: Number(process.env.MEMORY_AUTO_REVIEW_THRESHOLD ?? 0.75)
  },

  nitro: {
    experimental: { tasks: true, websocket: true },
    // Serve the Silero VAD assets (worklet + ONNX model) and onnxruntime-web WASM
    // from the app origin so the client VAD can fetch them (see useVoice.ts asset paths).
    publicAssets: [
      { baseURL: 'vad', dir: vadAssetDir, maxAge: 60 * 60 * 24 * 30 },
      { baseURL: 'ort', dir: ortAssetDir, maxAge: 60 * 60 * 24 * 30 }
    ],
    scheduledTasks: {
      '*/5 * * * *': ['embed-documents'],
      '*/10 * * * *': ['enrich-input'],
      '*/7 * * * *': ['enrich-images'],
      '*/15 * * * *': ['enrich-memories'],
      '0 3 * * *': ['prune-activity-log']
    }
  }
})
