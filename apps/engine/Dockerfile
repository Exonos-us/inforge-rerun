# The engine of one workspace: its coworkers, their memory, files, schedules, browser and screen.
# Built from the repository root: docker build -f apps/engine/Dockerfile .
FROM node:22-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN --mount=type=cache,id=rerun-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --filter rerun-engine...
RUN pnpm --filter @rerun/contracts build && pnpm --filter rerun-engine build
RUN pnpm --filter rerun-engine deploy --prod /out

FROM base AS runtime
# git and jq for the coworkers' shell, Xvfb and the desktop packages for the screen a person can
# watch, Chromium's own dependencies for the browser tool.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git jq xvfb openbox x11vnc xdotool thunar xfce4-terminal adwaita-icon-theme tint2 hsetroot maim ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash rerun && mkdir -p /data && chown rerun:rerun /data
COPY --from=build --chown=rerun:rerun /out /app
RUN npx --yes patchright@1.63.0 install-deps chromium && rm -rf /var/lib/apt/lists/*
# Codex drives a ChatGPT plan, at CODEX_VERSION (src/runtime/codex-cli.ts). Claude Code ships inside
# the Agent SDK, already in /app.
RUN npm install -g "@openai/codex@0.166.0"
USER rerun
RUN cd /app && npx patchright install --no-shell chromium
ENV PATH="/home/rerun/.local/bin:${PATH}" \
    NODE_ENV=production \
    RERUN_DATA_DIR=/data \
    RERUN_HOST=0.0.0.0 \
    RERUN_PORT=3000 \
    RERUN_CODEX_PATH=/usr/local/bin/codex
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/cli/bin.js", "run"]
