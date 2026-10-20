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
  web/             Chat interface, React (planned)
docker/            Image, compose file and install script (planned)
docs/              Project documentation
```

Rules between folders:

- `src/web` never imports from `src/server`. They talk over HTTP only.
- Shared request and response types live in `src/shared` once they exist.

## Storage

SQLite through `node:sqlite`, in the data volume. No native dependencies.

## Claude

The Claude Agent SDK runs the `claude` CLI installed by Anthropic's installer
(`pathToClaudeCodeExecutable`). Sign-in, status and the agent all use that one
CLI. See [provider terms](PROVIDER_TERMS.md).
