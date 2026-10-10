import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './packages/core/src/db/schema/index.ts',
  out: './server/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! }
})
