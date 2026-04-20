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
# git dep's prepare script. pnpm 9 accepts the lockfile as-is.
# typescript is needed globally because chrome-less's prepare step runs
# `tsc` inside its extracted tarball during `pnpm install`.
RUN npm install -g pnpm@9.15.0 typescript@5.7.2

USER yap
WORKDIR /home/yap/app

ENV NODE_ENV=production \
    PORT=3001 \
    OLLAMA_HOST=http://ollama:11434 \
    MODEL=qwen2.5:14b \
    CHROME_LESS_CHROME=/usr/bin/chromium \
    MAX_TOOL_ROUNDS=8

# Install dependencies first so the layer caches on source-only edits.
# `--ignore-scripts` skips both the chrome-less git-dep prepare (which
# fails in a temp folder without yap's @types/node visible) and prisma's
# postinstall. We run prisma generate and build chrome-less's CLI
# manually below, where the full dep graph is available.
COPY --chown=yap:yap package.json pnpm-lock.yaml* ./
COPY --chown=yap:yap prisma ./prisma
RUN pnpm install --prod=false --ignore-scripts
RUN pnpm exec prisma generate
RUN cd node_modules/chrome-less && \
    npm install --no-save --silent @types/node @types/ws && \
    ../../node_modules/.bin/tsc -p tsconfig.json || tsc -p tsconfig.json

COPY --chown=yap:yap tsconfig.json ./
COPY --chown=yap:yap src ./src

EXPOSE 3001

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "start"]
