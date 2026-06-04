# syntax=docker/dockerfile:1
# MyMind — Nuxt 4 (Nitro node-server). Multi-stage; runtime keeps deps + migrations
# so the container can run `pnpm db:migrate` on start.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- build ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# allow the sharp native build script (approved in pnpm-workspace.yaml)
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- runtime ----
FROM base AS runtime
ENV NODE_ENV=production NITRO_PORT=3000 NITRO_HOST=0.0.0.0
# Copy the whole built app (incl. node_modules, .output, server/db/migrations,
# drizzle.config.ts) so the entrypoint can migrate then serve.
COPY --from=build /app /app
EXPOSE 3000
# Apply pending migrations, then start the Nitro server.
CMD ["sh", "-c", "pnpm db:migrate && node .output/server/index.mjs"]
