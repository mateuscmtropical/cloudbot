# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- `browser_click` checks the focus after a click. A click on a field that did not take the focus is repeated once, and the result tells the model whether a field has the focus.

### Added

- Live screen: a Screen button in the conversation header shows the bot's desktop in the chat with noVNC. The view is view only. The server proxies a WebSocket at `/api/desktop/vnc` to x11vnc on `127.0.0.1:5900` and refuses requests without the session cookie.
- Rules panel: a Rules button in the conversation header opens the owner rules of the bot. The owner can add allow and block rules, name blocked tools and remove rules there.
- Owner rules: each bot has allow and block rules in plain words, stored on the server and read for every turn. The sentences go into the system prompt, and block rules can name tools that the SDK then refuses. Routes: `GET`, `POST /api/bots/:id/rules` and `DELETE /api/bots/:id/rules/:ruleId`.
- `browser_type_secret`: the server types a saved secret into the focused password, one-time code or card field, only on the site saved with it. The bot never sees the value.
- Screenshots in the chat: `browser_screenshot` takes `showOwner`, and the screenshot then also appears in the chat. The chat shows a preview of PNG, JPEG, GIF and WEBP files up to 5 MB above the download link.
- Browser tools: the bot can open web pages, read them, take screenshots, click, type, press keys and scroll in the Chromium on its desktop. Only http and https addresses can be opened, and page content is framed as data for the model.
- Secrets the bot asks for: with the `request_secret` tool the bot asks the owner for a password, a code or a payment detail. The chat shows a secure form with the https site where the value will be used. The value goes to the vault, tied to the bot and the site, and never reaches the model or the chat history.
- Desktop: the image has a virtual screen with Chromium, a terminal and a VNC server, run as the bot user. The server starts it and starts it again when it exits. Chromium and VNC listen on localhost only. Default choices that wait for the owner are in `docs/OWNER_QUESTIONS.md`.
- File downloads: the bot can send a file from its workspace to the chat with the `share_file` tool. The server copies the file (at most 50 MB, regular files inside the workspace only) and the chat shows a download link. Downloads need the session cookie and are sent as attachments.
- Shared file cleanup: copies of files the bot shared are removed `CLOUDBOT_UPLOAD_RETENTION_DAYS` days after they were shared, in the same daily job as the upload cleanup. A copy is also removed when its message cannot be saved.
- Image check: before an attached image goes to Claude as an image block, its header and end marker are checked and its sides must be at most 8000 pixels. A file that fails is still listed by path.
- Upload cleanup: files are removed `CLOUDBOT_UPLOAD_RETENTION_DAYS` days after the upload (default 30). Files that were never sent are removed after one day. A bot with a running or queued message keeps its files. The cleanup runs on start and once a day.
- Messages sent while a bot answers are queued and run in order after the current turn. When Claude reports a usage limit, the turn waits for the reset time, then continues. The chat shows when it resumes. Queued messages and waits survive a restart, and Stop cancels the wait and the queue.
- Scripted Claude setup in the first bot's chat, with subscription sign-in or
  an API key form, persisted progress, retry messages and guarded answer routes.
  Answered forms close in the web app. API mode starts the local key proxy and
  keeps the real key out of the agent environment.
- Optional agent execution as the bot user with restricted sudo, a minimal environment and workspaces outside the server data folder.
- Persistent bot home and workspace volumes for Claude credentials, sessions and bot memory. The CLI in the home volume updates itself across image upgrades.
- Attachments: `POST /api/bots/:id/attachments` saves uploaded files in a per-bot upload folder that the bot can read but not change, up to `CLOUDBOT_MAX_UPLOAD_MB` (default 20). The next message lists the files, and PNG, JPEG, GIF and WEBP images up to 5 MB also go to Claude as images. The web app shows the files in the user message.
- Claude subscription login helpers for the setup chat, with sign-in links,
  code submission, cancellation, timeout handling and CLI status checks.
- Project setup: server with a health route, lint, tests, CI and docs.
- Secrets vault with encryption at rest, a secure form endpoint and a local key proxy that adds the API key to requests.
- SQLite storage for bots, messages and settings with Drizzle ORM, with migrations that run on start. Migrations are found next to the install, not in the working directory.
- Agent runner that streams one conversation turn through the Claude Agent SDK.
- Bot profile: the bot can change its own name, title and description from the chat, and its system prompt says who it is and where its memory lives (`CLAUDE.md`).
- One-command install on Debian and Ubuntu (`docker/install.sh`) with a free sslip.io HTTPS name or your own domain, and the `cloudbot` command for status, logs, update and setup links. See `docs/INSTALL.md`.
- Docker image and compose file with Caddy in front for HTTPS. The server runs as `cloudbot` and the Claude Code CLI is installed for `bot`. The data volume is readable only by `cloudbot`. CI builds the image and checks the health route and the isolation of the data folder.
- Chat API: list bots, read and send messages, stop a running turn, and stream the turn events over Server-Sent Events.
- Live replies: the chat shows the text of an answer as it is written. The default bot CloudBot is created on the first start.
- Older messages: the chat loads the page before the oldest message when you scroll to the top. `GET /api/bots/:id/messages` takes `before` and `limit` (default 50, capped at 200).
- Chat web interface in `src/web`: bot list, Markdown messages, setup messages and a composer. The server serves the build from `dist/web`.
- One-time setup link printed on start. Opening it sets a session cookie, and every `/api` route except health needs that cookie. A new code ends the old sessions.
- `pnpm setup-link` prints a new setup link for an owner who lost the cookie. Set `CLOUDBOT_PUBLIC_URL` to make the link use your public address.

### Fixed

- Claude login and auth status use the isolated agent user and minimal environment, with the login pseudo terminal wrapping sudo.
- Production startup requires an agent user. Container checks verify that it is bot and validate sudo denial messages.
- Workspace permissions are restored explicitly after creation and on reuse without default ACLs. Preparation errors are logged on the server and hidden from chat.
- Agent stderr is drained through a pipe with only its last 4 KB retained for failure diagnostics.
