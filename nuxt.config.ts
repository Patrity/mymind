// https://nuxt.com/docs/api/configuration/nuxt-config
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
    ai: {
      reasoning: { baseURL: process.env.AI_REASONING_BASE_URL, apiKey: process.env.AI_REASONING_API_KEY, model: process.env.AI_REASONING_MODEL },
      bulk: { baseURL: process.env.AI_BULK_BASE_URL, apiKey: process.env.AI_BULK_API_KEY, model: process.env.AI_BULK_MODEL },
      embeddings: { baseURL: process.env.AI_EMBEDDINGS_BASE_URL, apiKey: process.env.AI_EMBEDDINGS_API_KEY, model: process.env.AI_EMBEDDINGS_MODEL },
      vision: { baseURL: process.env.AI_VISION_BASE_URL, apiKey: process.env.AI_VISION_API_KEY, model: process.env.AI_VISION_MODEL },
      stt: { baseURL: process.env.AI_STT_BASE_URL, apiKey: process.env.AI_STT_API_KEY, model: process.env.AI_STT_MODEL },
      ttsKokoro: { baseURL: process.env.AI_TTS_KOKORO_BASE_URL, apiKey: process.env.AI_TTS_KOKORO_API_KEY, model: process.env.AI_TTS_KOKORO_MODEL, voice: process.env.AI_TTS_KOKORO_VOICE },
      ttsChatterbox: { baseURL: process.env.AI_TTS_CHATTERBOX_BASE_URL, apiKey: process.env.AI_TTS_CHATTERBOX_API_KEY, model: process.env.AI_TTS_CHATTERBOX_MODEL, voice: process.env.AI_TTS_CHATTERBOX_VOICE },
      rerankBaseUrl: process.env.AI_RERANK_BASE_URL ?? '',
      rerankApiKey: process.env.AI_RERANK_API_KEY ?? ''
    },
    memoryAutoReviewThreshold: Number(process.env.MEMORY_AUTO_REVIEW_THRESHOLD ?? 0.75)
  },

  nitro: {
    experimental: { tasks: true, websocket: true },
    scheduledTasks: {
      '*/5 * * * *': ['embed-documents'],
      '*/10 * * * *': ['enrich-input'],
      '*/7 * * * *': ['ocr-images'],
      '*/15 * * * *': ['enrich-memories']
    }
  }
})
