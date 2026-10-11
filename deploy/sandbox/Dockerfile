# mymind-sandbox — the per-workspace agent sandbox (cycle 82, spec §2).
# Built on the box by deploy/sandbox/build-image.sh → mymind-sandbox:<sha> + mymind-sandbox:current.
#
# Runtime flags live in packages/core/src/lib/sandbox/docker.ts (user 10001, cap-drop ALL,
# no-new-privileges, read-only rootfs + tmpfs /tmp and /home/agent, pids/mem/cpu limits, the
# mymind-sandbox network). This image only supplies the toolchain and the unprivileged user.
#
# Environment hygiene: the image declares NO ENV beyond PATH/LANG. Everything in an image's ENV
# ends up in every process inside the sandbox (/proc/1/environ), so node/uv are COPIED from their
# official images (whose ENV — NODE_VERSION, YARN_VERSION … — is left behind) rather than used as
# the base. Layer order: slow, rarely-changing apt layer first; small COPY layers after.

# Base images are pinned by multi-arch index DIGEST (amd64 prod, arm64 dev Mac); the tag is a comment
# for humans. Bump deliberately: `docker buildx imagetools inspect <tag>` → new digest here.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS node
FROM ghcr.io/astral-sh/uv:0.9.2@sha256:6dbd7c42a9088083fa79e41431a579196a189bcee3ae68ba904ac2bf77765867 AS uv

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep procps less \
      python3 python3-venv \
      build-essential \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Node 22 + npm/corepack from the official image (binary + its bundled modules only).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && npm install -g --no-fund --no-audit pnpm@10.34.6 \
 && rm -rf /root/.npm /root/.cache

# uv / uvx (static binaries).
COPY --from=uv /uv /uvx /usr/local/bin/

# The unprivileged user every sandbox process runs as (docker run --user 10001:10001).
RUN groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --home-dir /home/agent --shell /bin/bash --no-create-home agent \
 && mkdir -p /workspace /home/agent \
 && chown 10001:10001 /workspace /home/agent \
 && chmod 0700 /home/agent

USER 10001:10001
WORKDIR /workspace
CMD ["sleep", "infinity"]
