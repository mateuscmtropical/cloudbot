# Architecture

This page describes the target layout. Parts that do not exist yet are marked
as planned.

## Processes

| Process | Runs as | Job |
|---|---|---|
| Server | `cloudbot` user | HTTP API, chat, setup, vault, task queue, storage |
| Agent | `bot` user | The `claude` CLI for one conversation, started by the SDK in the server |
| Key proxy | `cloudbot` user | Adds the API key to requests from the agent, so the agent never holds it |
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
the CLI does not run. The runtime installs sudo and sets `CLOUDBOT_AGENT_USER=bot`.
`SdkAgentRunner` reads that setting and `CLAUDE_PATH`, with constructor options
available for explicit configuration. Production startup fails if no agent user
is configured. Without an agent user, local development on Windows and macOS
keeps the normal SDK spawn behavior.

With an agent user, the SDK's `spawnClaudeCodeProcess` hook starts
`sudo -n -u bot -- /home/bot/.local/bin/claude` with the SDK arguments as a
literal argument array. It forwards the SDK working directory and cancellation
signal, with piped input and output. The sudoers file permits only this CLI
path as `bot`, with any CLI arguments, without a password. It grants no root
commands, shells or environment override permission. The image validates the
file with `visudo`.

The login and auth status helpers use the same sudo command and minimal
environment. For login, `script` wraps sudo in a pseudo terminal. Credentials
and sessions therefore belong to `bot` in `/home/bot`. Without an agent user,
the helpers retain their direct CLI execution for local development.

The agent's stderr is piped and drained rather than inherited into server
logs. Only its last 4096 bytes are retained for failure diagnostics, printed
as one JSON-quoted line when the SDK throws. Workspace preparation failures
are logged on the server and reach chat as a short message without paths.

The wrapper constructs an environment containing only `HOME=/home/bot` and a
fixed system `PATH`. When the caller supplies the key proxy's
`ANTHROPIC_BASE_URL` in the runner environment, it also passes that URL and a
fixed dummy `ANTHROPIC_API_KEY`. It drops all other caller and SDK environment
values, including real keys and auth tokens. Sudo resets the environment,
sets the target user's home and identity variables, applies the same fixed
system path and preserves only the two proxy variables. Sudo may add its own
process metadata. Server environment secrets are never inherited by the CLI.

The image prepares `/var/lib/cloudbot-workspaces` outside the private data
folder. The root belongs to `bot:bot` and has mode 2770. `cloudbot` is a
member of the `bot` group. Before starting a turn, the server creates
`/var/lib/cloudbot-workspaces/<botId>` with mode 770. Bot ids must be single
safe path components. The setgid parent makes the new directory's group `bot`.
After creation and on reuse, the server explicitly sets mode 770 to restore
group write access regardless of its umask, without relying on filesystem ACLs.
The creator remains `cloudbot`, so these directories are owned by
`cloudbot:bot`, while bot-created files belong to `bot`. This shared group
design lets the server create workspaces without another sudo command or
permission to change owners. Existing files and symbolic links are rejected
as workspace directories. All bots share one Unix account, so workspaces do
not isolate bots from each other.

Compose and the CI container mount separate named volumes at `/home/bot`,
`/var/lib/cloudbot-workspaces` and `/var/lib/cloudbot-uploads`, alongside the private server data volume.
They preserve login credentials, sessions and workspace memory in `CLAUDE.md`
across container replacement. New volumes inherit the image's ownership and
permissions. The CLI in the bot home volume updates itself and is not replaced
by a new image, because the mounted volume hides the image's copy of `/home/bot`.

The server finds `drizzle/` relative to its install folder, so it starts
from any working directory. The image health check calls `/api/health`.

`docker/install.sh` runs on a fresh Debian or Ubuntu server as root. It installs Docker when
it is missing, clones the repository to `/opt/cloudbot`, writes `CLOUDBOT_DOMAIN` to
`/opt/cloudbot/.env`, starts the compose file with that env file and copies
`docker/cloudbot` to `/usr/local/bin/cloudbot`. The `cloudbot` command wraps status,
logs, update and setup-link. The setup link is read from the container logs.

`docker/compose.yaml` runs the server and Caddy. `docker/Caddyfile` reads the
domain from `CLOUDBOT_DOMAIN`. CI runs `docker/check-container.sh` on the built
image. It checks the health route, proves that `bot` cannot read a file the
server user wrote to the data folder, verifies the allowed CLI sudo command
and denied shell and root commands, and checks bot write access to a
server-created workspace.

## Folders

```text
src/
  server/          HTTP server and the code that wires the parts together
    access/        Setup link, session cookie and the check that guards /api
    agent/         Runs one conversation turn through the Claude Agent SDK
    chat/          Chat routes, the turn run and the event stream to the web app
    createApp.ts   Hono app and routes
    main.ts        Entry point
    claudeAuth/    CLI subscription login sessions and sign-in status
    store/         SQLite storage: bots, messages, settings and migrations
    vault/         Encrypted secrets, secure form route and key proxy
  shared/          Types shared by the server and the web app
    chatTypes.ts   Messages, bots and chat events
  web/             Chat interface in React, built with Vite to dist/web and served by the server
docker/            Dockerfile, compose file, Caddyfile, install.sh, the cloudbot command and the container check script
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

## Chat

`ChatService` in `src/server/chat/` holds the chat rules. It stores the user
message, runs one turn at a time per bot through an `AgentRunner`, and stores
each reply. A message sent during a turn joins the bot's queue and runs after
it. It is saved at once and marked as queued until its turn starts. When the
runner reports a rejected usage limit, the turn waits until the reset time, or
5 minutes when the runner gives none. Then it runs again: the same message if
no session event came, otherwise a short "Continue." turn in the same session.
The chat shows the resume time as a system message. Stop during a wait cancels
the wait and the queue. The queue and the wait are stored in SQLite, so they
survive a restart, and the timers are rebuilt on start. The Claude session id from the runner is saved on the bot, so the
next turn resumes it.

Routes are under `/api/bots`: list bots, list and send messages, stop a turn,
and `GET /events`. The event stream sends a `turn` event on connect, then the
`message` and `turn` events in the order they happen. While a text block is
written, the server sends `textDelta` events with the partial text. Deltas are
never stored. When the block ends, its whole text goes out once as a `message`
event, which replaces the draft. The web app shows the draft as an assistant
bubble, so the text is never shown twice.

## Attachments

Uploads go to `POST /api/bots/:id/attachments` as multipart form data. Hono's
`bodyLimit` caps the request body at `CLOUDBOT_MAX_UPLOAD_MB` (default 20) and
answers 413 before anything is read. A request holds at most 10 files, so more
gets 400. `saveFiles` in `src/server/attachments/` reads each file into memory
and writes it under a generated name with flag `wx`. The mode is set on the open
handle and the folder mode again after `mkdir`, so the umask cannot strip the
bot's read access. Files are 0640 and folders 2750. If one write fails, every
attempted path is removed, including a partial file.

Files live outside the agent's writable workspace. In agent user mode the folder
is `/var/lib/cloudbot-uploads/<botId>`, owned by cloudbot with group bot. The bot
can read the files and cannot create, rename or replace anything. Without an
agent user the folder is `<dataDir>/uploads/<botId>`. `ChatService.uploadDirFor`
returns it. Every turn passes the folder to the SDK as an additional directory,
so the agent can read an earlier upload by its path.

`ChatService` keeps the saved files as pending for the bot, with their bytes in
memory. The pending queue of a bot holds at most 10 files and
`CLOUDBOT_MAX_UPLOAD_MB` bytes. An upload that would go over gets 413, and its
files are removed. Uploads are refused with 409 while a reply runs for the bot
or a usage limit wait is pending, so the queue is empty during a turn. The web
app disables the attach button for the same time. `GET /api/bots/:id/uploads`
lists the queue, and `DELETE /api/bots/:id/uploads/:uploadId` drops one file and
deletes it. The next turn that starts takes the queue, and its prompt lists the
absolute paths. A turn that
ends without a session event from the agent puts its files back in the queue,
whatever the reason, such as a stop during startup or a failed start. A turn
that got a session event keeps its files, so the agent never gets the same files
twice.

`ChatService.cleanUploads` runs on start and once a day. A pending file that was
never sent is removed after one day. Any other file in the upload folders is
removed when its modification time is older than `CLOUDBOT_UPLOAD_RETENTION_DAYS`
(default 30). The age counts from the upload, not from the send. A bot with a
running, queued or waiting turn keeps all its files. The age comes from the file
time, so a pending file lost in a restart is treated as used.

Images up to 5 MB go to the SDK as image blocks, built from the bytes in memory.
The disk is never read back for them. Images are detected from their first bytes,
not from the client type. Before an image becomes a block, `readImageSize` reads
its pixel size from the header and checks that the file has the end marker its format
says, so a truncated file or one that only starts like an image is refused. A
side over 8000 pixels is refused too, as in the
[vision docs](https://platform.claude.com/docs/build-with-claude/vision). The
check does not decode the pixels. A refused image is still listed by path in the
prompt. The user message stores the file names for the web app.
The web app shows the pending files as chips, disables Send while a file is still
uploading, and clears only the chips that existed when the message was sent. It
reloads the pending files when a turn ends, so files put back by a turn show up.
Pending files live in memory, so a restart drops them.

## Shared files

The bot hands a file to the owner with `share_file`, a second tool in the
`cloudbot` MCP server (`mcp__cloudbot__share_file`). The tool takes one path.
`shareWorkspaceFile` in `src/server/files/` resolves it against the workspace
and follows links with `realpath`, so a link that leads out of the workspace is
refused. It then opens the file with `O_NOFOLLOW` and `O_NONBLOCK`, so a named
pipe cannot hang the call. It resolves the open handle through `/proc/self/fd`
and checks the workspace again, which catches a folder swapped for a link after
the first check. Then it checks that the file is a regular file of at most 50 MB, and copies it into
`<dataDir>/shared/<botId>/<fileId>` with mode 0600. The copy lives in the
private server data, so the bot cannot change it after sharing. The copy stops
when more than the limit passes, and a failed copy is removed. Refusals reach
the model as tool errors, and other failures give a fixed text.

`ChatService.shareFile` then posts a `file` message with the name, type, size
and file id. The type comes from a short list of extensions, and everything else,
including html and svg, is `application/octet-stream`.
`GET /api/bots/:id/messages/:mid/file` finds the file through the message, so a
download needs the message id and the right bot. It sends the copy with
`Content-Disposition: attachment`, `nosniff` and `no-store`. A missing copy
answers 404. The web app shows a download link in the message.

Shared files are not cleaned up yet.

## Secrets


The vault in `src/server/vault/` encrypts each secret with AES-256-GCM. Its
key is in `vault.key`, next to `vault.json`, and both files belong to the
server user. The secure form endpoint stores a value and never sends it back.
The key proxy listens on 127.0.0.1 and adds the API key to each request to
Anthropic. The agent gets `ANTHROPIC_BASE_URL` and a dummy key, never the real
one.

## Setup conversation

`SetupConversation` in `src/server/setup/` writes scripted messages through
`ChatService`, so setup uses the same storage and live message events as chat.
It starts before the HTTP server, in the first bot's conversation. Until setup
finishes, messages to any bot receive a short reminder without starting an agent
turn or storing the submitted text.

The `claude.setup` entry in `SettingsStore` holds the step, chosen mode and
active message id. Subscription mode is connected only when CLI auth status
confirms sign-in. API mode is connected when `ANTHROPIC_API_KEY` exists in the
vault. Startup checks the chosen connection again and restores setup if it is
missing. An interrupted subscription login starts a new CLI process and replaces
the old link and code field. Pending choices and API forms survive a restart.

Session-protected `POST /api/bots/:id/messages/:mid/choice`, `/code` and `/secret`
routes accept setup answers. Answers are serialized and must match the bot,
message kind, active step and message id. Choices save only `chosenId`. Code
fields and secure forms save only `submitted`, which also closes expired forms.
Message updates are published over SSE and replace the existing message in the
web app. Replayed answers are rejected.

Subscription codes go directly to the in-memory login session, then setup waits
for completion and confirms CLI status. Fixed failure messages avoid exposing
terminal input from dependency errors. Keys go directly into the vault under
`ANTHROPIC_API_KEY`, without an API validation request. Neither codes nor keys
enter message bodies, settings, responses or logs.

`main.ts` starts the loopback key proxy when API mode connects, including after
a restart. The runner environment receives its `ANTHROPIC_BASE_URL` and a dummy
key. Subscription mode receives no API key or proxy URL. Server environment
API credentials are removed before constructing the runner environment.

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
It exposes `signInUrl`, `submitCode`, `cancel` and `finished` for the
setup conversation. `signInUrl` resolves to null if login ends before a link
arrives. Failures name timeout, missing CLI, unsuccessful exit or cancellation.
Sessions time out after five minutes by default.

After a successful exit, the caller must use `getClaudeAuthStatus` to confirm
sign-in. It returns only login state and the authentication method. These
helpers do not read credential files or persist terminal output or codes.
The setup conversation calls these helpers and exposes only fixed status messages.
