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

# Enable the pnpm version pinned by packageManager/lockfile.
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

USER yap
WORKDIR /home/yap/app

ENV NODE_ENV=production \
    PORT=3001 \
    OLLAMA_HOST=http://ollama:11434 \
    MODEL=qwen2.5:14b \
    CHROME_LESS_CHROME=/usr/bin/chromium \
    MAX_TOOL_ROUNDS=8

# Install dependencies first so the layer caches on source-only edits.
# `postinstall` runs `prisma generate` to produce the typed client.
COPY --chown=yap:yap package.json pnpm-lock.yaml* ./
COPY --chown=yap:yap prisma ./prisma
RUN pnpm install --prod=false

COPY --chown=yap:yap tsconfig.json ./
COPY --chown=yap:yap src ./src

EXPOSE 3001

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "start"]
