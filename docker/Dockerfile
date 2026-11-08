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

# Server side voice input. Pinned by commit and by checksum, and built here so the build tools stay out of the image.
# On x86 the CPU variants load at run time, so one image uses AVX2 where the machine has it and still runs where it does not.
# The compiler in Debian does not know the newest Arm variants, so Arm gets one build. It uses dotprod and fp16 when the CPU
# that builds the image has them, and otherwise the NEON every 64 bit Arm CPU has.
# So an Arm image runs on a CPU like the one that built it. Every install builds its own image.
FROM base AS whisper
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates cmake curl g++ git make \
    && git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp.git /whisper-src \
    && test "$(git -C /whisper-src rev-parse HEAD)" = d1be6fde11ac6e0407606b4e42fe72d34add8037 \
    && case "$(uname -m)" in \
        aarch64) cpu_flags='-DGGML_BACKEND_DL=OFF -DGGML_CPU_ALL_VARIANTS=OFF' \
            && if grep -qw asimddp /proc/cpuinfo && grep -qw asimdhp /proc/cpuinfo; then cpu_flags="$cpu_flags -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16"; fi ;; \
        *) cpu_flags='-DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON' ;; \
    esac \
    && cmake -S /whisper-src -B /whisper-build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON \
        -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON '-DCMAKE_INSTALL_RPATH=$ORIGIN' \
        -DGGML_NATIVE=OFF $cpu_flags \
        -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
    && cmake --build /whisper-build --config Release --target whisper-cli -j "$(nproc)" \
    && install -d /whisper \
    && cp -a /whisper-build/bin/. /whisper/ \
    && find /whisper-build/src /whisper-build/ggml/src -name '*.so*' -exec cp -a {} /whisper/ \; \
    && curl -fsSL -o /whisper/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base-q5_1.bin \
    && curl -fsSL -o /whisper/ggml-silero.bin https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin \
    && echo '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898  /whisper/ggml-base.bin' | sha256sum -c - \
    && echo '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987  /whisper/ggml-silero.bin' | sha256sum -c -

FROM base AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash bubblewrap ca-certificates curl sudo \
        chromium fonts-dejavu-core fonts-liberation jgmenu openbox procps tigervnc-standalone-server tint2 wmctrl \
        x11-utils x11-xserver-utils xdotool xterm \
        poppler-utils python3 python3-docx python3-lxml python3-openpyxl \
        python3-pil python3-pip python3-pypdf python3-reportlab python3-typing-extensions \
        python3-xlsxwriter git openssl ffmpeg libgomp1 tini \
    && rm -rf /var/lib/apt/lists/*

# The GitHub CLI comes from GitHub's own apt repository, as its install page describes.
RUN install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# matplotlib comes from pip wheels. The Debian package pulls python3-fonttools, python3-scipy, gcc and g++, about 600 MB.
# pillow comes from apt above. --only-binary makes the build fail instead of compiling anything.
RUN python3 -m pip install --no-cache-dir --no-deps --only-binary=:all: --break-system-packages \
        numpy==2.2.6 matplotlib==3.10.7 contourpy==1.3.2 cycler==0.12.1 fonttools==4.60.1 kiwisolver==1.4.9 \
        pyparsing==3.2.5 python-dateutil==2.9.0.post0 packaging==25.0 six==1.17.0
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
    && install -d -o cloudbot -g cloudbot -m 0700 /var/lib/cloudbot-hub \
    && install -d -o bot -g bot -m 2770 /var/lib/cloudbot-workspaces \
    && install -d -o cloudbot -g bot -m 2750 /var/lib/cloudbot-uploads \
    && install -d -o cloudbot -g bot -m 2710 /var/lib/cloudbot-turns \
    && install -d -o cloudbot-integrations -g cloudbot-integrations -m 0700 /var/lib/cloudbot-integrations \
    && install -d -m 1777 /tmp/.X11-unix

COPY --chmod=0440 docker/cloudbot-agent.sudoers /etc/sudoers.d/cloudbot-agent
COPY --chmod=0755 docker/cloudbot-desktop /usr/local/bin/cloudbot-desktop
COPY --chmod=0755 docker/cloudbot-desktop-input /usr/local/bin/cloudbot-desktop-input
# Debian's chromium launcher reads /etc/chromium.d, so every start of Chromium gets the gate and the bot profile.
COPY --chmod=0644 docker/chromium-flags /etc/chromium.d/cloudbot
# The desktop panel and its app menu. COPY --chmod would give the folder the file mode too.
RUN install -d -m 0755 /usr/local/share/cloudbot
COPY --chmod=0644 docker/tint2rc docker/jgmenurc /usr/local/share/cloudbot/
# The steps for a CloudBot update, which the bot reads when the owner asks. Root owns it, so the bot cannot change them.
COPY --chmod=0644 docker/self-update.md /usr/local/share/cloudbot/self-update.md
COPY --chmod=0755 docker/cloudbot-remove-workspace /usr/local/bin/cloudbot-remove-workspace
COPY --chmod=0755 docker/cloudbot-read-memory /usr/local/bin/cloudbot-read-memory
COPY --chmod=0755 docker/cloudbot-write-memory /usr/local/bin/cloudbot-write-memory
COPY --chmod=0755 docker/cloudbot-signal-group /usr/local/bin/cloudbot-signal-group
COPY --chmod=0755 docker/cloudbot-end-turn /usr/local/bin/cloudbot-end-turn
COPY --chmod=0755 docker/cloudbot-codex /usr/local/bin/cloudbot-codex
RUN visudo -cf /etc/sudoers.d/cloudbot-agent

# pipefail makes a failed download fail the build instead of piping nothing into bash.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# bot can write its own home, so the CLI runs from a root-owned copy instead. The installer runs as bot in a
# temporary home, and the copy and the removal happen in the same step, so no layer keeps a second copy.
# The build fails if any file named claude is left under the bot home.
# The date only forces a new download of the latest CLI. Change it to update Claude. The CLIs installed by a script below update with any change to that step.
RUN : cli-refresh-2026-11-04 \
    && install -d -o bot -g bot -m 0700 /tmp/claude-install \
    && runuser -u bot -- env HOME=/tmp/claude-install bash -o pipefail -c 'curl -fsSL https://claude.ai/install.sh | bash' \
    && cp -L /tmp/claude-install/.local/bin/claude /usr/local/bin/claude \
    && chown root:root /usr/local/bin/claude \
    && chmod 0755 /usr/local/bin/claude \
    && rm -rf /tmp/claude-install \
    && ! find /home/bot -name claude \( -type f -o -type l \) -print | grep -q . \
    && /usr/local/bin/claude --version

# The Codex CLI for bots that run on a ChatGPT subscription. The version must match CODEX_PROTOCOL_VERSION in
# src/server/agent/codexProtocol.ts. npm installs it as root, so the bot user cannot replace it.
RUN npm install --global @openai/codex@0.166.0 \
    && npm cache clean --force \
    && /usr/local/bin/codex --version

# The Bitwarden CLI for browser_fill_login. Only the server process runs it, with its state in a folder under
# /var/lib/cloudbot that the bot cannot open. The version is more than two weeks old and is pinned exactly.
# npm installs it as root, so the bot user cannot replace it.
RUN npm install --global @bitwarden/cli@2026.9.1 \
    && npm cache clean --force \
    && /usr/local/bin/bw --version

# ai-memory keeps the long-term memory of the bots. The server runs it on loopback, see src/server/memory. The release is
# pinned by version and by a checksum for each architecture, so a new release needs a new pin here. The release checksum
# file is checked as well. Only the binary is installed, owned by root, so the bot user cannot replace it. The build fails
# if the binary does not report the pinned version.
RUN case "$(dpkg --print-architecture)" in \
        amd64) memory_archive=ai-memory-linux-x86_64.tar.gz; memory_sha256=15a4f4a346a27e6fd63a36d1b3de23c5cbe142b80b3bce561e21b1f225a1e645 ;; \
        arm64) memory_archive=ai-memory-linux-aarch64.tar.gz; memory_sha256=164f7c38bb9bafca218dd958c3c60febcd5d2f5200ad138c6f128576cedebfb6 ;; \
        *) echo "No ai-memory build for this architecture." >&2; exit 1 ;; \
    esac \
    && install -d -m 0700 /tmp/ai-memory-install \
    && release_url=https://github.com/akitaonrails/ai-memory/releases/download/v3.4.2 \
    && curl -fsSL -o "/tmp/ai-memory-install/$memory_archive" "$release_url/$memory_archive" \
    && curl -fsSL -o "/tmp/ai-memory-install/$memory_archive.sha256" "$release_url/$memory_archive.sha256" \
    && (cd /tmp/ai-memory-install && sha256sum -c "$memory_archive.sha256") \
    && echo "$memory_sha256  /tmp/ai-memory-install/$memory_archive" | sha256sum -c - \
    && tar -xzf "/tmp/ai-memory-install/$memory_archive" -C /tmp/ai-memory-install ./ai-memory \
    && install -o root -g root -m 0755 /tmp/ai-memory-install/ai-memory /usr/local/bin/ai-memory \
    && rm -rf /tmp/ai-memory-install \
    && test "$(/usr/local/bin/ai-memory --version)" = "ai-memory 3.4.2"

# The agent CLIs of the other providers, which CloudBot runs over the Agent Client Protocol, see
# src/server/providers/acpProviders.ts. They are root-owned, so the bot user cannot replace them. The ones without an
# npm package come from each vendor's own install script, installed under /opt and linked into /usr/local/bin.
# OpenCode comes as the one glibc binary for this architecture. Its launcher package would install every Linux
# variant. On x86-64 it is the baseline build, which also runs on CPUs without AVX2.
# The npm, uv and installer caches are removed in the same step, since no CLI reads them at run time.
RUN case "$(dpkg --print-architecture)" in \
        amd64) opencode_package=@opencode/cli-linux-x64-baseline ;; \
        arm64) opencode_package=@opencode/cli-linux-arm64 ;; \
        *) echo "No OpenCode build for this architecture." >&2; exit 1 ;; \
    esac \
    && npm install --global @google/gemini-cli@0.66.0 @github/copilot@1.0.105 @qwen-code/qwen-code@0.26.7 "$opencode_package@2.2.5" \
    && ln -sf "/usr/local/lib/node_modules/$opencode_package/bin/opencode" /usr/local/bin/opencode \
    && install -d -m 0755 /opt/cloudbot-agents \
    && export HOME=/opt/cloudbot-agents \
    && curl -fsS https://cursor.com/install | bash \
    && curl -fsSL https://x.ai/cli/install.sh | bash \
    && curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && curl -fsSL https://antigravity.google/cli/install.sh | bash \
    && UV_TOOL_DIR=/opt/cloudbot-agents/uv-tools UV_TOOL_BIN_DIR=/opt/cloudbot-agents/uv-bin UV_PYTHON_INSTALL_DIR=/opt/cloudbot-agents/python \
        /opt/cloudbot-agents/.local/bin/uv tool install --python 3.12 mistral-vibe==3.1.0 \
    && ln -sf /opt/cloudbot-agents/.local/bin/cursor-agent /usr/local/bin/cursor-agent \
    && ln -sf /opt/cloudbot-agents/.grok/bin/grok /usr/local/bin/grok \
    && ln -sf /opt/cloudbot-agents/.kimi-code/bin/kimi /usr/local/bin/kimi \
    && ln -sf /opt/cloudbot-agents/uv-bin/vibe-acp /usr/local/bin/vibe-acp \
    && ln -sf /opt/cloudbot-agents/.local/bin/agy /usr/local/bin/agy \
    && chmod -R a+rX,go-w /opt/cloudbot-agents \
    && for cli in gemini copilot qwen opencode cursor-agent grok kimi vibe-acp agy; do ls -l "/usr/local/bin/$cli" && "/usr/local/bin/$cli" --version; done \
    && rm -rf /opt/cloudbot-agents/.cache /root/.cache /root/.npm \
    && find /tmp -mindepth 1 -maxdepth 1 ! -name .X11-unix -exec rm -rf {} +
COPY --chmod=0755 docker/cloudbot-provider /usr/local/bin/cloudbot-provider
COPY --chmod=0755 docker/cloudbot-print-url /usr/local/bin/cloudbot-print-url
# COPY --chmod would give a folder it makes the file mode too, which nobody could enter.
RUN install -d -m 0755 /usr/local/lib/cloudbot
COPY --chmod=0644 docker/acp-login.js docker/agy-login.js docker/agy-hook.js docker/provider-usage.js /usr/local/lib/cloudbot/

# Whisper and its models, read-only for everyone. Only the server user runs it, on audio in its private data folder.
COPY --from=whisper /whisper /usr/local/lib/cloudbot/whisper

USER cloudbot
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json

# The bots' long-term memory is on in the image. CLOUDBOT_AI_MEMORY=off turns it off, and the hub passes the setting on.
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    CLOUDBOT_DATA_DIR=/var/lib/cloudbot \
    CLOUDBOT_AGENT_USER=bot \
    CLOUDBOT_INTEGRATION_USER=cloudbot-integrations \
    CLAUDE_PATH=/usr/local/bin/claude \
    CODEX_PATH=/usr/local/bin/codex \
    CLOUDBOT_DESKTOP_COMMAND=/usr/local/bin/cloudbot-desktop \
    CLOUDBOT_AI_MEMORY=on

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

# Processes whose parent exits, like the children of an agent CLI, pass to PID 1. Node does not reap them, tini does.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/main.js"]
