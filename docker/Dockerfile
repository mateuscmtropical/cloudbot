# syntax=docker/dockerfile:1

# Build from the repository root:
#   docker build -f docker/Dockerfile -t cloudbot .

FROM node:24-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl sudo \
        chromium fonts-dejavu-core fonts-liberation openbox procps x11vnc xterm xvfb \
    && rm -rf /var/lib/apt/lists/*

# cloudbot runs the server and owns the data. bot runs the Claude Code CLI and
# cannot read the data folder, which is mode 700 and owned by cloudbot.
RUN groupadd --system cloudbot \
    && useradd --system --gid cloudbot --no-create-home --shell /usr/sbin/nologin cloudbot \
    && useradd --create-home --shell /bin/bash bot \
    && usermod -a -G bot cloudbot \
    && install -d -o cloudbot -g cloudbot -m 0700 /var/lib/cloudbot \
    && install -d -o bot -g bot -m 2770 /var/lib/cloudbot-workspaces \
    && install -d -o cloudbot -g bot -m 2750 /var/lib/cloudbot-uploads \
    && install -d -m 1777 /tmp/.X11-unix

COPY --chmod=0440 docker/cloudbot-agent.sudoers /etc/sudoers.d/cloudbot-agent
COPY --chmod=0755 docker/cloudbot-desktop /usr/local/bin/cloudbot-desktop
RUN visudo -cf /etc/sudoers.d/cloudbot-agent

# pipefail makes a failed download fail the build instead of piping nothing into bash.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
USER bot
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN /home/bot/.local/bin/claude --version

USER cloudbot
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json

ENV NODE_ENV=production \
    PORT=3000 \
    CLOUDBOT_DATA_DIR=/var/lib/cloudbot \
    CLOUDBOT_AGENT_USER=bot \
    CLAUDE_PATH=/home/bot/.local/bin/claude \
    CLOUDBOT_DESKTOP_COMMAND=/usr/local/bin/cloudbot-desktop

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "dist/server/main.js"]
