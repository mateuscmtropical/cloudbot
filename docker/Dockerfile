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
        poppler-utils python3 python3-docx python3-lxml python3-matplotlib python3-openpyxl \
        python3-pil python3-pip python3-pypdf python3-reportlab python3-typing-extensions \
        python3-xlsxwriter git openssl \
    && rm -rf /var/lib/apt/lists/*

# The GitHub CLI comes from GitHub's own apt repository, as its install page describes.
RUN install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Debian bookworm has no python3-pptx package. Its dependencies come from apt above.
RUN python3 -m pip install --no-cache-dir --no-deps --break-system-packages python-pptx==1.0.2

# cloudbot runs the server and owns the data. bot runs the Claude Code CLI and
# cannot read the data folder, which is mode 700 and owned by cloudbot.
RUN groupadd --system cloudbot \
    && useradd --system --gid cloudbot --no-create-home --shell /usr/sbin/nologin cloudbot \
    && useradd --create-home --shell /bin/bash bot \
    && useradd --system --home-dir /var/lib/cloudbot-integrations --shell /usr/sbin/nologin cloudbot-integrations \
    && usermod -a -G bot cloudbot \
    && install -d -o cloudbot -g cloudbot -m 0700 /var/lib/cloudbot \
    && install -d -o bot -g bot -m 2770 /var/lib/cloudbot-workspaces \
    && install -d -o cloudbot -g bot -m 2750 /var/lib/cloudbot-uploads \
    && install -d -o cloudbot -g bot -m 2710 /var/lib/cloudbot-turns \
    && install -d -o cloudbot-integrations -g cloudbot-integrations -m 0700 /var/lib/cloudbot-integrations \
    && install -d -m 1777 /tmp/.X11-unix

COPY --chmod=0440 docker/cloudbot-agent.sudoers /etc/sudoers.d/cloudbot-agent
COPY --chmod=0755 docker/cloudbot-desktop /usr/local/bin/cloudbot-desktop
COPY --chmod=0755 docker/cloudbot-remove-workspace /usr/local/bin/cloudbot-remove-workspace
COPY --chmod=0755 docker/cloudbot-signal-group /usr/local/bin/cloudbot-signal-group
RUN visudo -cf /etc/sudoers.d/cloudbot-agent

# pipefail makes a failed download fail the build instead of piping nothing into bash.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
USER bot
RUN curl -fsSL https://claude.ai/install.sh | bash

# bot can write its own home, so the CLI runs from a root-owned copy instead. The bot's copies are removed,
# and the build fails if any file named claude is left under the bot home.
USER root
RUN cp -L /home/bot/.local/bin/claude /usr/local/bin/claude \
    && chown root:root /usr/local/bin/claude \
    && chmod 0755 /usr/local/bin/claude \
    && rm -rf /home/bot/.local/bin/claude /home/bot/.local/share/claude \
    && ! find /home/bot -name claude \( -type f -o -type l \) -print | grep -q . \
    && /usr/local/bin/claude --version

USER cloudbot
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    CLOUDBOT_DATA_DIR=/var/lib/cloudbot \
    CLOUDBOT_AGENT_USER=bot \
    CLOUDBOT_INTEGRATION_USER=cloudbot-integrations \
    CLAUDE_PATH=/usr/local/bin/claude \
    CLOUDBOT_DESKTOP_COMMAND=/usr/local/bin/cloudbot-desktop

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "dist/server/main.js"]
