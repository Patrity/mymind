# syntax=docker/dockerfile:1
# LEGACY (B3.1): the app now runs NATIVELY via systemd in LXC 114 — see deploy/mymind.service
# + docs/DEPLOYMENT.md (Native deploy). This Dockerfile is no longer in the deploy flow; kept
# for reference / emergency rollback only.
# MyMind — Nuxt 4 (Nitro node-server). Multi-stage; runtime keeps deps + migrations
# so the container can run `pnpm db:migrate` on start.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- build ----
FROM base AS build
# Public runtime config that Nuxt inlines into the CLIENT bundle at `nuxt build`
# time (NUXT_PUBLIC_* are baked, not read at runtime for the SPA). Passed as a
# build arg from compose (which interpolates it from .env).
ARG NUXT_PUBLIC_UNMUTE_URL=""
ENV NUXT_PUBLIC_UNMUTE_URL=$NUXT_PUBLIC_UNMUTE_URL
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

# Install util-linux (provides setpriv) — required by the constrained exec tool, which
# spawns exec children via `setpriv --reuid --regid --clear-groups` to fully drop root
# privileges (uid/gid + supplementary groups). Node's spawn({uid,gid}) does NOT clear
# supplementary groups; setpriv is the only safe path.
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*

# A dedicated low-privilege user for the exec tool. The app process stays root so
# it can setuid the exec child down to this user; /workspace is the exec cwd-jail
# (a named volume in compose). exec FAILS CLOSED if it cannot drop to this user.
RUN groupadd -g 10001 agent && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin agent \
    && mkdir -p /workspace && chown agent:agent /workspace
ENV EXEC_AGENT_UID=10001 EXEC_AGENT_GID=10001 EXEC_WORKSPACE_DIR=/workspace

EXPOSE 3000
# Apply pending migrations, then start the Nitro server.
CMD ["sh", "-c", "pnpm db:migrate && node .output/server/index.mjs"]
