# Architecture

This page describes the target layout. Parts that do not exist yet are marked
as planned.

## Processes

| Process | Runs as | Job |
|---|---|---|
| Server | `cloudbot` user | HTTP API, chat, setup, vault, task queue, storage |
| Agent | `bot` user | The Claude Agent SDK and the `claude` CLI for one conversation (planned) |
| Key proxy | `cloudbot` user | Adds the API key to requests from the agent, so the agent never holds it (planned) |
| Computer | `bot` user | Desktop, Chromium and noVNC for the bot's screen (planned, v0.2) |

The bot runs as its own Linux user. Files that belong to the server user, such
as the vault and the database, are not readable by the bot.

## Docker

`docker/Dockerfile` builds on `node:24-bookworm-slim` in four stages: a base with pnpm,
production dependencies, the build, then the runtime image. The runtime
image has two users. `cloudbot` runs the server and owns `/var/lib/cloudbot`,
which is mode 700 and holds `CLOUDBOT_DATA_DIR`. `bot` installs the Claude
Code CLI with Anthropic's installer (`curl -fsSL https://claude.ai/install.sh | bash`),
which puts it in `/home/bot/.local/bin/claude`. The image sets `CLAUDE_PATH` to that path,
so the server can pass it to the SDK as `pathToClaudeCodeExecutable`. The build fails if
the CLI does not run.

The server finds `drizzle/` relative to its install folder, so it starts
from any working directory. The image health check calls `/api/health`.

`docker/compose.yaml` runs the server and Caddy. `docker/Caddyfile` reads the
domain from `CLOUDBOT_DOMAIN`. CI runs `docker/check-container.sh` on the built
image. It checks the health route and proves that `bot` cannot read a file the
server user wrote to the data folder.

Not wired yet: the server does not run the agent as `bot`. Until it does,
the CLI runs as `cloudbot`, and the isolation check only covers the data folder.

## Folders

```text
src/
  server/          HTTP server and the code that wires the parts together
    access/        Setup link, session cookie and the check that guards /api
    agent/         Runs one conversation turn through the Claude Agent SDK
    createApp.ts   Hono app and routes
    main.ts        Entry point
    claudeAuth/    CLI subscription login sessions and sign-in status
    store/         SQLite storage: bots, messages, settings and migrations
    vault/         Encrypted secrets, secure form route and key proxy
  shared/          Types shared by the server and the web app
    chatTypes.ts   Messages, bots and chat events
  web/             Chat interface in React, built with Vite to dist/web and served by the server
docker/            Dockerfile, compose file, Caddyfile and the container check script
docs/              Project documentation
```

Rules between folders:

- `src/web` never imports from `src/server`. They talk over HTTP only.
- Shared request, response and message types live in `src/shared`.

## Storage

SQLite through `node:sqlite`, in the data volume. No native dependencies.
Queries go through Drizzle ORM. Drizzle's `sqlite-proxy` driver sends its SQL
to `node:sqlite`, so there is no native binding.

The database is `cloudbot.db` in the folder given by `CLOUDBOT_DATA_DIR`
(default `./data`). `schema.ts` declares the tables. `openDatabase` enables WAL
and foreign keys, then applies the migrations in `drizzle/` that have not run
yet. `BotStore`, `MessageStore` and `SettingsStore` wrap the tables.

After a schema change, run `pnpm db:generate` to write a new migration into
`drizzle/`. Generated migrations are append only: never edit one that has
shipped, add a new one instead.

## Access

On start, a server with no session prints a setup link with a one-time code.
Opening the link sets a session cookie (`HttpOnly`, `Secure`, `SameSite=Strict`)
and the code stops working. Every `/api` route except health needs the cookie.
Only SHA-256 hashes of the code and the session token are stored, in the
settings table, and they are compared in constant time. Issuing a new code
clears the session, which ends old sessions. This keeps strangers out. It is
not a sign-in.

The link starts with `CLOUDBOT_PUBLIC_URL` when it is set, and with
`http://localhost:PORT` otherwise. `buildSetupLink` in `setupLinkUrl.ts` builds
it for both the server start and the `setup-link` entry point. The cookie is
`Secure`, so the link works only on localhost or over HTTPS.

`pnpm setup-link` runs `dist/server/newSetupLink.js`. It opens the same
database, issues a new code and prints the link, which ends every session. The
running server reads the code from the database on each request, so it does
not need a restart. Run it with the server stopped or the database idle, since
both processes write to the same SQLite file.

## Secrets

The vault in `src/server/vault/` encrypts each secret with AES-256-GCM. Its
key is in `vault.key`, next to `vault.json`, and both files belong to the
server user. The secure form endpoint stores a value and never sends it back.
The key proxy listens on 127.0.0.1 and adds the API key to each request to
Anthropic. The agent gets `ANTHROPIC_BASE_URL` and a dummy key, never the real
one.

## Claude

The Claude Agent SDK runs the `claude` CLI installed by Anthropic's installer
(`pathToClaudeCodeExecutable`). Sign-in, status and the agent all use that one
CLI. See [provider terms](PROVIDER_TERMS.md).

The bot profile reaches the agent in two ways. `buildSystemPrompt` turns the
name, title and description into a prompt that is appended to Claude Code's
default prompt, so the bot keeps its tool and coding instructions. The prompt
also says the bot runs
on the owner's VPS through CloudBot, and that its memory is `CLAUDE.md` in its
workspace. `createProfileToolServer` builds an in-process MCP server with one
tool, `update_profile`, which saves changes through `BotStore`. The tool is
bound to one bot id, and it is allowed up front so headless turns never ask.
The tool trims its fields and caps them at 40, 80 and 500 characters. It writes
only the fields the model passed, so a reply cannot overwrite the others. The
profile text is framed as the owner's words, with newlines collapsed, so it
cannot add instructions as new paragraphs. The server is built for each turn,
and its key in `mcpServers` must be `cloudbot`, because `allowedTools` names the
tool as `mcp__cloudbot__update_profile`. The SDK loads `CLAUDE.md` from the
working directory by default, so the workspace file is the bot's memory.

`startClaudeLogin` runs login in a util-linux `script` pseudo terminal on Linux.
It exposes `signInUrl`, `submitCode`, `cancel` and `finished` for the planned
setup conversation. `signInUrl` resolves to null if login ends before a link
arrives. Failures name timeout, missing CLI, unsuccessful exit or cancellation.
Sessions time out after five minutes by default.

After a successful exit, the caller must use `getClaudeAuthStatus` to confirm
sign-in. It returns only login state and the authentication method. These
helpers do not read credential files or persist terminal output or codes.
The setup conversation and HTTP wiring are still planned.
