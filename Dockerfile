# syntax=docker/dockerfile:1.6

# ------------------------------------------------------------------
# Stage 1: pre-build chrome-less
#
# chrome-less is a github-hosted dep (`github:hasangilak/chrome-cli`).
# When pnpm installs it, the package's `prepare` script runs in an
# isolated temp dir that doesn't see yap's @types/*, so `tsc` fails.
# We build it once here with its own deps resolved, then copy the
# built tree into the final image.
# ------------------------------------------------------------------
FROM node:22-bookworm-slim AS chrome-less-builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone https://github.com/hasangilak/chrome-cli.git chrome-less \
 && cd chrome-less \
 && git checkout 49e721aec4d687db24add69320780c36a7f8a644 \
 && npm install --silent \
 && npm run build \
 && sed -i 's|"--headless=new",|"--headless=new","--no-sandbox","--disable-setuid-sandbox",|' dist/chrome.js

# ------------------------------------------------------------------
# Stage 2: yap runtime image
# ------------------------------------------------------------------
FROM node:22-bookworm-slim

# System deps:
#   chromium   — the actual browser that chrome-less drives via CDP
#   git        — required so pnpm can resolve the `github:` dep
#   tini       — clean PID-1 that reaps the chrome + chrome-less children
#   fonts      — so pages render text; saves "missing glyph" boxes in a11y
#   openssl    — required by Prisma's binary engine at runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-noto-core \
      git \
      openssl \
      tini \
 && rm -rf /var/lib/apt/lists/*

# Chromium refuses to launch as root unless you pass --no-sandbox, and
# chrome-less doesn't pass that flag. Running as a regular user sidesteps
# the whole thing.
RUN useradd --create-home --shell /bin/bash --uid 1001 yap

# Pin pnpm 9 explicitly. Corepack was downloading pnpm 10, which adds a
# strict `onlyBuiltDependencies` allowlist that rejects the chrome-less
# git dep's prepare script.
RUN npm install -g pnpm@9.15.0

USER yap
WORKDIR /home/yap/app

ENV NODE_ENV=production \
    PORT=3001 \
    OLLAMA_HOST=http://ollama:11434 \
    MODEL=qwen2.5:14b \
    CHROME_LESS_CHROME=/usr/bin/chromium \
    MAX_TOOL_ROUNDS=8

# Install dependencies with scripts disabled. Then materialize prisma's
# generated client manually, and swap chrome-less's install for the one
# we pre-built above. pnpm places git deps in node_modules/chrome-less
# as a symlink into .pnpm/; removing the symlink and dropping a real
# directory keeps module resolution intact (Node resolves
# `chrome-less/dist/cli.js` under node_modules/ before touching .pnpm/).
COPY --chown=yap:yap package.json pnpm-lock.yaml* ./
COPY --chown=yap:yap prisma ./prisma
RUN pnpm install --prod=false --ignore-scripts \
 && pnpm exec prisma generate \
 && rm -rf node_modules/chrome-less
COPY --from=chrome-less-builder --chown=yap:yap /build/chrome-less /home/yap/app/node_modules/chrome-less

COPY --chown=yap:yap tsconfig.json ./
COPY --chown=yap:yap src ./src

EXPOSE 3001

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "start"]
