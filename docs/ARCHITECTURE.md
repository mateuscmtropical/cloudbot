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

## Folders

```text
src/
  server/          HTTP server and the code that wires the parts together
    createApp.ts   Hono app and routes
    main.ts        Entry point
    claudeAuth/    CLI subscription login sessions and sign-in status
    store/         SQLite storage: bots, messages, settings and migrations
    vault/         Encrypted secrets, secure form route and key proxy
  web/             Chat interface, React (planned)
docker/            Image, compose file and install script (planned)
docs/              Project documentation
```

Rules between folders:

- `src/web` never imports from `src/server`. They talk over HTTP only.
- Shared request and response types live in `src/shared` once they exist.

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

`startClaudeLogin` runs login in a util-linux `script` pseudo terminal on Linux.
It exposes `signInUrl`, `submitCode`, `cancel` and `finished` for the planned
setup conversation. `signInUrl` resolves to null if login ends before a link
arrives. Failures name timeout, missing CLI, unsuccessful exit or cancellation.
Sessions time out after five minutes by default.

After a successful exit, the caller must use `getClaudeAuthStatus` to confirm
sign-in. It returns only login state and the authentication method. These
helpers do not read credential files or persist terminal output or codes.
The setup conversation and HTTP wiring are still planned.
