// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@nuxtjs/mdc'
  ],

  devtools: {
    enabled: true
  },

  // Hybrid rendering: authed app routes are SPA (ssr:false), public /share/** stays SSR.
  //
  // Mechanism: SSR remains enabled globally (default). routeRules disables SSR for every
  // authed app route, making them serve a minimal SPA shell so the auth middleware never
  // runs on the server (eliminates the pre-login /documents flash + hydration mismatches).
  // /share/** is left as the default (ssr:true) so public share pages remain server-rendered
  // for OG/SEO.
  //
  // NOTE: Global ssr:false + per-route ssr:true was attempted but does NOT work in Nuxt 4.
  // When ssr:false is set globally the renderer is compiled to always use getSPARenderer()
  // regardless of routeRules — the per-route override only goes the other direction
  // (SSR→SPA via routeRules ssr:false). Verified empirically in preview build.
  // The correct supported hybrid mode is: ssr:true globally + ssr:false per route.

  css: ['~/assets/css/main.css'],

  routeRules: {
    '/': { redirect: '/documents' },
    // Authed app routes: SPA shell only — no server rendering.
    // Auth middleware runs client-side only; no pre-login flash.
    '/documents': { ssr: false },
    '/documents/**': { ssr: false },
    '/clipboard': { ssr: false },
    '/capture': { ssr: false },
    '/gallery': { ssr: false },
    '/memories': { ssr: false },
    '/projects': { ssr: false },
    '/review': { ssr: false },
    '/tasks': { ssr: false },
    '/login': { ssr: false },
    // /share/** is intentionally left out — default ssr:true keeps it server-rendered.
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
    ai: {
      reasoning: { baseURL: process.env.AI_REASONING_BASE_URL, apiKey: process.env.AI_REASONING_API_KEY, model: process.env.AI_REASONING_MODEL },
      bulk: { baseURL: process.env.AI_BULK_BASE_URL, apiKey: process.env.AI_BULK_API_KEY, model: process.env.AI_BULK_MODEL },
      embeddings: { baseURL: process.env.AI_EMBEDDINGS_BASE_URL, apiKey: process.env.AI_EMBEDDINGS_API_KEY, model: process.env.AI_EMBEDDINGS_MODEL },
      vision: { baseURL: process.env.AI_VISION_BASE_URL, apiKey: process.env.AI_VISION_API_KEY, model: process.env.AI_VISION_MODEL },
      stt: { baseURL: process.env.AI_STT_BASE_URL, apiKey: process.env.AI_STT_API_KEY },
      tts: { baseURL: process.env.AI_TTS_BASE_URL, apiKey: process.env.AI_TTS_API_KEY },
      rerankBaseUrl: process.env.AI_RERANK_BASE_URL ?? '',
      rerankApiKey: process.env.AI_RERANK_API_KEY ?? ''
    },
    memoryAutoReviewThreshold: Number(process.env.MEMORY_AUTO_REVIEW_THRESHOLD ?? 0.75)
  },

  nitro: {
    experimental: { tasks: true },
    scheduledTasks: {
      '*/5 * * * *': ['embed-documents'],
      '*/10 * * * *': ['enrich-input'],
      '*/7 * * * *': ['ocr-images'],
      '*/15 * * * *': ['enrich-memories']
    }
  }
})
