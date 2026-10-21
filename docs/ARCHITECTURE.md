# Architecture

This page describes the target layout. Parts that do not exist yet are marked
as planned.

## Processes

| Process | Runs as | Job |
|---|---|---|
| Server | `cloudbot` user | HTTP API, chat, setup, vault, task queue, storage |
| Agent | `bot` user | The `claude` CLI for one conversation, started by the SDK in the server |
| Key proxy | `cloudbot` user | Adds the API key to requests from the agent, so the agent never holds it |
| Desktop | `bot` user | Virtual screen, Chromium, a terminal and a VNC server, started by the server |

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
    desktop/       Starts the bot's desktop and starts it again when it exits
    main.ts        Entry point
    claudeAuth/    CLI subscription login sessions and sign-in status
    models/        Model choices per kind of work: validation and routes
    store/         SQLite storage: bots, messages, settings and migrations
    vault/         Encrypted secrets, secure form route and key proxy
    webhooks/      Webhook URLs: the public hook route, owner routes and bot tools
  shared/          Types shared by the server and the web app
    chatTypes.ts   Messages, bots and chat events
  web/             Chat interface in React, built with Vite to dist/web and served by the server
docker/            Dockerfile, compose file, Caddyfile, install.sh, the cloudbot command and the container check script
docs/              Project documentation
```

Rules between folders:

- `src/web` never imports from `src/server`. They talk over HTTP only.
- Shared request, response and message types live in `src/shared`.

## Desktop

The image installs Xvfb, openbox, xterm, Chromium and x11vnc. The script
`docker/cloudbot-desktop`, installed as `/usr/local/bin/cloudbot-desktop`,
starts them as `bot` on display `:1` with a 1280 by 800 screen. Chromium keeps
its profile in `/home/bot/.config/cloudbot-chromium`, so sign-ins survive a
restart. It listens for the DevTools protocol on `127.0.0.1:9222`. x11vnc
listens on `127.0.0.1:5900` without a password. Neither port leaves the
container, because compose exposes only the server port.

The live view of the screen is a WebSocket at `/api/desktop/vnc`.
`attachVncProxy` in `src/server/desktop/` answers the HTTP upgrade, checks the
session cookie, and pipes the frames to x11vnc on `127.0.0.1:5900` as raw
bytes. Without a valid cookie the upgrade gets a 401. The web app loads noVNC
only when the owner opens the Screen panel, and sets it to view only.

The image sets `CLOUDBOT_DESKTOP_COMMAND` to the script path. The server runs
`sudo -n -u bot -- /usr/local/bin/cloudbot-desktop`, and sudoers allows that
script only without arguments. `DesktopSupervisor` starts it again when it
exits, after 2 seconds, then 4, 8 and up to 60. A run of a minute or more
resets the delay. Without the variable, as in local development, there is no
desktop. The server passes only `HOME` and `PATH` to sudo, because sudoers
keeps the `ANTHROPIC_` variables for the CLI. The script's own error messages
reach the server log as one quoted line.

The script holds a lock, so only one desktop runs. On start it stops parts
left over from a crash and removes stale X and Chromium locks. It checks every part
once a second. When one part exits, it stops the others and exits, so the server starts a clean desktop.
Its log is `/home/bot/.cache/cloudbot-desktop/desktop.log` and starts empty
each time.

### Browser tools

When the desktop is enabled, the cloudbot tool server also has browser tools.
`BrowserControl` in `src/server/desktop/` finds the first page in
`/json/list` on the DevTools port, opens a WebSocket to it with Node's built-in
client and closes it after each action. A new blank page is opened when none
is left.

| Tool | What it does |
|---|---|
| `browser_open` | Opens an http or https address, waits up to 15 seconds for it to load and returns its title, address and visible text |
| `browser_read` | Returns the title, address and visible text of the open page |
| `browser_screenshot` | Returns a PNG of the page to the model. With `showOwner`, it is also posted to the chat |
| `browser_click` | Clicks at a point, in screenshot pixels |
| `browser_type` | Types text into the focused field |
| `browser_key` | Presses Enter, Tab, Escape, Backspace, an arrow key, PageUp or PageDown |
| `browser_scroll` | Scrolls the page by a number of pixels |

A load that fails, such as an unknown host, is an error and does not return
the old page. Each action enables the Page domain first. A dialog that opens
during an action is closed with Cancel, and its text goes back to the model.
A leave-page (`beforeunload`) dialog is accepted, so the bot can leave.
A dialog that was already open blocks every call but a navigation, so the
tools then answer within 3 seconds and tell the model to use `browser_open`.
DevTools requests and the WebSocket connection give up after 5 seconds.

Page text is cut at 20000 characters and is framed as data, not instructions.
The system prompt says the same. Other schemes such as `file:` and
`javascript:` are refused. Unexpected errors reach the model as a short
generic message.

Chromium runs with `--no-sandbox`, because Docker's default seccomp profile
blocks the namespaces its sandbox needs. Open choices like this one are listed
in [OWNER_QUESTIONS.md](OWNER_QUESTIONS.md).

### Network gate

Chromium sends all its traffic through a SOCKS5 gate in the server process,
`BrowserGate` in `src/server/desktop/BrowserGate.ts`, on `127.0.0.1:9224`. The
gate speaks SOCKS5 as RFC 1928 defines it, with CONNECT only and no
authentication. For each request it resolves the name itself, or uses the
address it was given. It connects only when every address is public by
`isPublicAddress`, or, for an allowed host, private and allowable by
`isAllowablePrivateAddress`. It connects to exactly that checked address. A name
that answers differently later, or a second address in the answer, cannot send
the bytes somewhere else. The name lookup gives up after 5 seconds.

The SOCKS replies are: 2 for a refused address, 4 when the name has no address
or the lookup times out, 5 when the connection fails, 7 for a command other than
CONNECT, and 8 for an unknown address type. Bytes sent before the tunnel opens
are capped at 64 KB. At most 256 clients are open at once, and a client past
that is closed. A client that leaves before its tunnel opens stops the session,
so nothing is connected for it. A server error after start is logged, and the
gate keeps running.

`docker/cloudbot-desktop` starts Chromium with `--proxy-server` for this port,
with `--proxy-bypass-list=<-loopback>`, so loopback goes through the gate too,
and with the WebRTC policy `disable_non_proxied_udp`, so UDP does not skip the
proxy. The two ports must match. When the gate is down, Chromium has no network.

An allowed host may reach private addresses, such as 10.x, 172.16/12, 192.168.x,
100.64/10 and fc00::/7, but every address it resolves to is checked. Loopback,
localhost, this machine's own addresses, 0.0.0.0, link-local (169.254/16 and
fe80::/10) and the metadata addresses (169.254.169.254 and fd00:ec2::254) can
never be allowed. `browser_allow_host` refuses those at once, when the host is a
literal or a localhost name, and the gate refuses them even for an allowed host.
The table `browser_allowed_hosts` (migration 0010) holds the allowed hosts and
ports, with port 0 for every port. It is shared by the browser, not kept per
bot. The bot adds a host with `browser_allow_host`, which always asks the owner
first, and the approval card shows the normalized host and the port or "any
port". `browser_allowed_hosts` and `browser_remove_host` do not ask.

A refused request is logged with the time, the host and the port, never the
path or the data. At most one line is written for each host and port in a
minute. A failed page load tells the model that the address may be private, and
the system prompt says the same. A refusal by the gate shows Chromium's
`net::ERR_SOCKS_CONNECTION_FAILED`, and the model is told to ask the owner before
using `browser_allow_host`.

The gate sees a host and a port, not the page. It covers the browser only. The
bot's shell is not behind it. Whether Chromium resolves names itself or leaves
that to the gate was not checked against a running Chromium here.

## Document tools

The image installs Python 3 from Debian with `openpyxl`, `python-docx`,
`python-pptx`, `reportlab`, `pypdf` and `matplotlib`, and `poppler-utils` for
`pdftotext`. Debian has no package for `python-pptx`, so pip installs version
1.0.2 without dependencies, which apt provides. The bot writes spreadsheets, documents, slides, PDFs and charts
into its workspace with its shell and sends them with `share_file`.
`buildSystemPrompt` names the libraries. `docker/check-container.sh` imports
each one as the `bot` user. Open choices are in
[OWNER_QUESTIONS.md](OWNER_QUESTIONS.md).

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

`ChatService.cleanUploads` runs on start and once a day, for uploads and shared files. A pending file that was
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
answers 404. The web app shows a download link in the message. For PNG, JPEG,
GIF and WEBP files up to 5 MB it also shows the image above the link. An
`img` tag never runs scripts, so a file with the wrong bytes only fails to show.

`ChatService.shareScreenshot` posts a screenshot from `browser_screenshot`
with `showOwner`. It decodes the PNG, checks the same 50 MB limit and writes it
to the same share folder with mode 0600, under a random file id. The message
name is `screenshot-YYYY-MM-DD-HH-MM-SS.png` in UTC. Screenshots are cleaned
up with the other shared copies.

`ChatService.cleanUploads` also removes shared copies in `<dataDir>/shared`
whose modification time is older than `CLOUDBOT_UPLOAD_RETENTION_DAYS`. The age
counts from the copy. A download after that gets 404. If the file message cannot
be saved, `shareFile` removes the copy before it rethrows the error.

## Secrets


The vault in `src/server/vault/` encrypts each secret with AES-256-GCM. Its
key is in `vault.key`, next to `vault.json`, and both files belong to the
server user. The secure form endpoint stores a value and never sends it back.
The key proxy listens on 127.0.0.1 and adds the API key to each request to
Anthropic. The agent gets `ANTHROPIC_BASE_URL` and a dummy key, never the real
one.

### Secrets the bot asks for

The `request_secret` tool takes a name in capital letters, a purpose and an
https site. The server posts a secure form with that site. The answer goes
through the same secret route as the setup form, but `ChatService` sees the
site in the form and saves the value with `BotSecrets` instead of the setup.
`BotSecrets` (`src/server/secrets/`) stores `{ site, value }` in the vault
under `BOT_<hash of the bot id>_<NAME>`, so each bot has its own names. The
form closes and a system message says what was saved, without the value. The
bot does not see the value. The owner tells the bot to continue. Names that
start with `ANTHROPIC_` or `CLAUDE_` are refused. A second answer to a form
while the first is saved is refused. The setup's recovery ignores forms with
a site, so a bot form never becomes the setup's API key form.

`browser_type_secret` takes a saved name. The server reads the value and calls
`BrowserControl.typeSecret`. In one DevTools connection it creates an isolated
world, so page scripts cannot change what the check reads. It then checks that
the page origin is the saved site and that the focused element is a password
input, or an input whose autocomplete says `current-password`, `new-password`,
`one-time-code`, `cc-number` or `cc-csc`. A focused frame is refused. Only then
does it type the value with `Input.insertText`. A search box or a text field is
refused, so a page cannot get the value into an address, onto the screen or
into a post. The tool result never holds the value.

## Owner rules

`RuleStore` keeps the owner's rules in the `bot_rules` table. Each row has the
bot, a kind (`allow` or `block`), a sentence and a list of blocked tools. The
routes `GET` and `POST /api/bots/:id/rules` and `DELETE
/api/bots/:id/rules/:ruleId` sit behind the session cookie. `parseRuleInput`
checks the input: a sentence of 1 to 300 characters, at most 20 tool names as
the SDK spells them, optionally with a pattern such as `Bash(rm:*)` without
commas. Only a block rule can name tools, and a bot has at most 50 rules. The
bot has no tool to read or change rules. A misspelled tool name blocks
nothing, so the sentence carries the intent.

The web app shows them in `RulesPanel`, opened with the Rules button in the
conversation header. It lists, adds and removes rules through these routes and
shows the server's error text when a rule is refused.

Each turn reads the bot's rules. `buildSystemPrompt` lists the sentences as
owner rules, and the blocked tools go to the SDK as `disallowedTools`, which
wins over `allowedTools`.

## Model choices

The web app shows them in `ModelsPanel`, opened with the Models button in the
conversation header. It saves all five choices with one `PUT`. The bot can
change them with the `models_set` tool. The tool merges the fields it gets with
the stored choices, validates the result with `parseModelInput`, and is
reviewed like other setting changes, because it is not on the skip list in
`classifyToolCall`.

`ModelStore` keeps one row per bot in the `bot_models` table, with a choice for
each kind of work: `chat`, `routines`, `review`, `browsing` and `documents`. A
null choice keeps the CLI default. For `browsing` and `documents` a null choice
means no helper agent. A choice is an alias the SDK accepts (`fable`, `opus`,
`sonnet` or `haiku`, listed in `MODEL_ALIASES`) or a full id that matches
`^claude-[a-z0-9.-]+$`. `parseModelInput` checks both. The routes `GET` and
`PUT /api/bots/:id/models` sit behind the session cookie. `PUT` replaces all
choices, and a missing field clears its choice.

Effort has the same five kinds. Each kind has an `effort` column in the same
`bot_models` row (`chat_effort`, `routines_effort`, and so on, added by the
migration `0007_effort`). A null effort is the CLI default. A level is one of
`low`, `medium`, `high`, `xhigh` or `max` (`EFFORT_LEVELS`). The JSON fields
are flat (`chatEffort`, `reviewEffort`, ...). `ModelStore` reads them with
`getEfforts` and writes them with `setEfforts`, so the model and effort
methods never overwrite each other. `GET` also returns `effortLevels`. A `PUT`
parses the models and the efforts before either is saved, so one bad level
returns 400 and saves nothing. `models_set` takes the same fields as a partial
update, and the bot is told to pick a sensible effort when the owner names a
model only.

A turn sends its choice to the SDK `model` option. A routine or webhook turn
uses the `routines` choice and falls back to `chat`. The `source` of a turn
(`chat`, `routine` or `webhook`) is stored with the queued turn, so a turn that
waits keeps its choice after a restart. The review model is read with the owner
rules on each review call.

The effort follows the same rule (`chooseTurnEffort`) and goes to the SDK
`effort` option. The review call gets the review effort, and each helper gets
its own effort on its `AgentDefinition`. An unset effort is left out, so the
CLI default applies.

## Turn limits

Each bot has three optional limits per turn: `minutes`, `usd` and `steps`. There
is one set for chat turns and one for turns started by routines, webhooks and
watches. `LimitStore` keeps them in the `bot_limits` table (migration
`0009_limits`), one row per bot. A null field means no limit. The routes `GET`
and `PUT /api/bots/:id/limits` use the nested shape `{ chat, routines }`, and
`parseLimitInput` validates it. The tool merges its flat arguments into the same
shape and uses the same parser. The
bot sets them with `limits_set`, which is reviewed like `models_set`.
`chooseTurnLimit` picks the set for a turn.

Each limit has its own mechanism:

- Time: `TurnDeadline` counts the working time of the turn. It holds while the
  turn waits on the owner. `ApprovalGate.onOwnerWait` reports an approval card,
  and `ScreenHolder.onChange` reports a screen handoff. The model review of a
  call is not owner wait.
- Steps: the SDK `maxTurns` option. The SDK reports `error_max_turns`, which
  becomes a `turn_limit` event with `limit: 'steps'`.
- Spending: the SDK `maxBudgetUsd` option, reported as `error_max_budget_usd`.
  The SDK `total_cost_usd` covers the main loop only, so the review agent cost
  is added through `reportReviewCost` and `recordReviewCost`. The turn stops
  when the review spend alone passes the cap. The two costs are not combined.
  The agent and the review agent are each held to the spending limit, so a turn
  can spend up to twice the limit. A review cost counts only for the turn that
  asked for it. A review that returns after its turn stopped is dropped, and
  stopping a turn also cancels its running review.

When a limit stops a turn, `stopTurnWithReason` aborts it and saves a system
message. For a limit, `describeLimitStop` builds the message. It names the limit
and its value, and it says where to raise the limit. `reportOwnerWait` is the one
place that reports waiting on or off for a turn, and `stopTurnWithReason` is the
one stop-with-reason path. The stall watch reuses both.

Known gaps: secure input (`requestSecret`) returns at once and does not pause
the clock. The SDK does not report the main-loop cost while a turn runs, so the
two costs are never added together. The helper agents' cost is assumed to count toward
`maxBudgetUsd`, as the SDK documents, and this is not checked at runtime.

## Stalled turns

A turn that sends no agent event for 10 minutes is stopped. The period is the
constant `STALL_MS` in `src/server/chat/StallWatchdog.ts`, not a setting.
`StallWatchdog` starts with the turn, and it starts again on each agent event of
the turn. An `activity` event counts too. The runner sends it for an SDK message
that maps to no other event, such as tool progress or a retry, and nothing shows
it in the chat. The watch counts it as proof that the turn is alive. Time the
owner is asked does not count. `reportOwnerWait` holds the
watch while an approval card or a screen handoff waits on the owner, and the
count starts again when the wait ends. When the watch fires, `stopTurnWithReason`
aborts the turn, and the chat says that it sent nothing for 10 minutes. A turn
that already stopped, by Stop or by a limit, gets no second message. The watch
stops when the turn finishes, so no timer is left behind.

Known gaps: a model review does not count as owner wait. It has a 60 second
timeout, so it stays well under the stall period. A runner that ignores its abort
signal still holds the queue, because the watch only aborts the turn.

## Webhooks

The owner creates a webhook in the Routines panel, with `POST
/api/bots/:id/webhooks` and `{ name }`. The route makes a random token of 32
bytes, encoded as base64url. The `webhooks` table keeps only its SHA-256 hash.
The response carries the full URL, `<public address>/hooks/<token>`, once. The
public address comes from `readPublicBaseUrl`, the same address as the setup
link. The owner route and the bot's `webhook_create` tool share `addBotWebhook`,
so both check the name and the limit of 10 webhooks in the same way.

The bot creates one with `webhook_create`. The tool result tells the model only
the name. The URL never reaches the model, the chat history or the log. The
tool sends it as a `webhookUrl` event on the bot's SSE stream, to the web app
that listens for that bot, and nothing is stored. The web app shows it once
with the same keep-secret text and Hide button as the panel. When no web app
listens for the bot, the tool creates nothing and tells the model to ask the
owner to open the web app or use the Routines panel. If the listener leaves
while the webhook is made, the tool removes that webhook again.

`POST /hooks/:token` is public, like the health route, so it sits outside the
session check. It answers 404 for an unknown token, 413 for a body over 64 KB,
429 after 30 calls a minute for all the webhooks of one bot, and 503 before the
setup is done.
An accepted call sends a chat message with source `webhook`. The message starts
with `Webhook <name>` and marks the body as text from outside. The turn waits in
the queue like any message, and it uses the `routines` model choice.

A call may send an `X-Delivery-Id` header. The id is trimmed, and an id longer
than 200 characters counts as no id. An id whose message was queued less than
24 hours ago gets `200 {"status":"duplicate"}` and is not queued again. The ids
are kept per webhook, at most 1000 of them, and the oldest go first. They live
in memory only, so a restart forgets them. An id is taken as soon as the call
starts, so a second call with the same id that arrives meanwhile is a duplicate.
If the call is then refused, the id is given back, so the same id can be sent
again. A deleted webhook drops its ids and its refused calls.

Each bot may have 10 webhook messages waiting in its queue (`MAX_QUEUED_WEBHOOK_TURNS`).
A call past that gets a `429` with a queue-full text, which is not the rate limit
text. The running turn does not count. The count is the messages waiting plus the
calls still being handled, so a burst cannot pass the cap while the queue is
still empty.

Each webhook keeps its last 20 refused calls in memory. Each entry holds a time
and one of four fixed reasons: `rate limit`, `queue full`, `body too large` or
`not ready`. The body, the token and the delivery id are never stored. The owner
sees the list in `GET /api/bots/:id/webhooks`, as `refusals` with the newest
first, and in the Routines panel. The bot sees the reasons in `webhook_list`.
The webhook is looked up before the body limit, so a 413 is recorded too. A call
with an unknown token matches no webhook, so it is not recorded.

The owner lists, creates and removes webhooks with `GET`, `POST` and `DELETE
/api/bots/:id/webhooks`, behind the session cookie. The Routines panel shows
them at the bottom. The bot has `webhook_list` (on the skip list of
`classifyToolCall`), `webhook_create` and `webhook_delete` (both reviewed). The review agent reads a
webhook message as `Webhook (outside data)`, not as the owner.

## Page watches

The bot creates a watch with `watch_create` (`{ name, url, intervalMinutes?,
keyword? }`). The tool is reviewed. It checks the address first with
`checkWatchUrl`, so a private address is refused before anything is saved.
The default interval is 60 minutes, the minimum 15, and a bot holds at most
10 watches. `watch_list` is on the skip list, `watch_delete` is reviewed. The
owner lists and removes watches with `GET` and `DELETE /api/bots/:id/watches`.

`WatchScheduler` runs every 30 seconds, like the routine scheduler. A due
watch first moves its next check, so a crash cannot repeat it at once. Then it
fetches the page through `fetchWatchedPage`, keeps the lines that contain the
keyword, and hashes them with SHA-256. The `watches` table keeps the hash and
the last text, capped at 20000 characters. The first check only records the
page. A later change sends a chat message with source `routine`, so it uses
the routines model and effort. The message starts with `Page watch "<name>"`
and marks the text as outside data. The review context labels it
`Page watch (outside data)`.

The fetch is the SSRF guard. Only http and https are read. The host is
resolved with `dns.lookup(all)`, and every address must be public. `isPublicAddress`
refuses loopback, private, link-local, CGNAT, multicast, reserved and
broadcast addresses, the IPv6 equivalents, and the addresses of the server
itself, and the benchmarking range 198.18.0.0/15 and the AWS IPv6 metadata
address. An IPv6 address that carries an IPv4 address (mapped `::ffff:0:0/96`,
NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) is checked by that IPv4 address, so an
embedded 127.0.0.1 is refused in every form. An IPv6 address that cannot be
read is refused.
The request is pinned to the address that was checked, through a `lookup`
hook, so a second DNS answer cannot change where it connects. Redirects are
followed by hand, at most 3, and each hop runs the same check. A response is
read only when it is a 200 with a `text/html` or `text/plain` type, and
reading stops past 1 MB. The request has a 15 second limit. Tests inject the
resolver and the request, so no test reaches the network.

## Helper agents

A helper is an SDK subagent with its own model. `browsing` gets the browser
tools (`BROWSER_TOOL_FULL_NAMES`) and exists only when the bot has a browser.
`documents` gets `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep` and
`share_file`. `buildHelperAgents` builds the `agents` option for the turn. A
helper exists only when its model choice is set. The main turn then also gets
the `Agent` tool in `allowedTools`, and one line of the system prompt per
helper tells it to hand that work over.

Safety for helper calls rests on three things. The owner's blocked tools go to
each helper as its `disallowedTools`, which the SDK documents as the list that
disallows tools for that agent. The `PreToolUse` review hook is installed for
the whole query. The SDK types say the hook input has `agent_id` "when the hook
fires from within a subagent", so helper calls are reviewed too. Not checked
against a live CLI: that the SDK enforces `disallowedTools` inside a helper.

## Tool call approval

`ApprovalGate` pauses a tool call until the owner answers. `SdkAgentRunner`
installs a `PreToolUse` hook when the turn request has `reviewToolCall`. The
hook runs for every tool, also for the ones in `allowedTools`. It returns
nothing for an allowed call and a `deny` with the reason for a refused one.

A `ToolCallReviewer` decides for each call: `allow`, `deny` with a reason, or
`ask` with a one line summary. `ask` posts a choice message with Approve and
Deny (`isApproval` on the body) and waits. The owner answers through the same
route as the setup choices, `POST /api/bots/:id/messages/:mid/choice`. Stop, a
timeout of one hour or a failing reviewer never lets the call through. Stop and
the timeout close the question as Deny, and a failing reviewer asks the owner.

Open questions live in memory. `ChatService.resumeQueue` closes any that a
restart left open. Without a `toolCallReviewer` option the gate does not exist
and no call waits.

### Review agent

`createToolCallReviewer` is the reviewer that `main.ts` gives to the chat
service. `classifyToolCall` sorts each call first:

- Reading and looking tools skip the review and run. The list is
  `SKIP_TOOL_NAMES`: `Read`, `Glob`, `Grep`, `LS`, `TodoWrite`, `WebSearch` and
  the bot's own `browser_open`, `browser_read`, `browser_screenshot`,
  `browser_scroll`, `request_screen`, `request_secret`, `share_file` and
  `update_profile`.
- A connector tool (`mcp__` but not the bot's own server) whose tool name (the part after the server name) has the
  word send, reply, purchase, buy, pay, checkout, book, booking, reserve or
  order always answers `ask`. The model is not consulted.
- A `Bash` command that mails or sends data out (`sendmail`, `curl` with a
  body or a method other than GET, `wget --post`) also always answers `ask`.
- A call whose input is longer than 10000 characters answers `ask`, because
  the model must see the whole input.
- Every other call goes to the model.

The model is one Claude Agent SDK call with no tools, no settings files, no
saved session and one turn (`createClaudeReviewModel`). It gets the tool call,
the owner rules of the bot and the last six chat lines, and answers with a
JSON object: `category`, `decision`, `summary` and `reason`. A category of
`send_message`, `purchase` or `booking` always becomes `ask`, whatever the
decision says. An answer that is not valid JSON, a failed call and a timeout of
60 seconds all throw, and the approval gate then asks the owner.

The always-ask rule is a name and pattern check, not a proof. A built in tool
that sends something in a way the patterns miss relies on the model's category.

Each reviewed call costs one extra model call. The review runs as the server
user, which is safe only because the call has no tools.

## Command floor

Before any rule, approval or model, `createToolCallReviewer` checks the call
against a fixed floor (`src/server/approvals/commandFloor.ts`). A match answers
`deny` with a short reason, and no rule, approval or model choice can lift it.

The floor refuses:

- A recursive delete (`rm -r`) of `/`, `/*`, `/root`, `/home`, the bot home,
  `~`, `$HOME` or `${HOME}`, the cloudbot data folders `/var/lib/cloudbot`,
  `/var/lib/cloudbot-workspaces` and `/var/lib/cloudbot-uploads`, also with a
  trailing `/`, a `/.` or a dot-file glob such as `$HOME/.*`. A `find` with
  `-delete` or `-exec rm` that starts at one of those folders is refused too,
  unless it has a filter: `-name`, `-iname`, `-path`, `-mtime` or `-mmin`. A
  type or size filter does not count.
- A format (`mkfs`, `mke2fs` or `mkswap` with a `/dev/` argument), a `dd` or
  `shred` onto a disk device, or `cp` (only its destination), `tee`, `wipefs`,
  `fdisk`, `sfdisk`, `sgdisk`, `parted` or `blkdiscard` on a disk device, or a
  redirect onto a disk device. Disk devices are `sd`, `hd`, `vd`, `xvd`, `nvme`,
  `mmcblk`, `disk`, `loop`, `md`, `dm-`, `mapper` and `zd`. The read-only forms
  pass: `-l` or `--list` as the first option of `fdisk` or `sfdisk`, and `print`
  in a `parted` command. Any other option order is refused, such as
  `fdisk /dev/sda -l`.
- A fork bomb.
- Stopping, disabling, masking, restarting or editing the cloudbot service or
  container: `systemctl` (the value of `-s`, `-p`, `-t` and similar options is
  skipped), `service cloudbot` or `service cloudbot.service`,
  `/etc/init.d/cloudbot stop` or `restart`, `pkill` and `killall` with a
  cloudbot name, and `docker stop|kill|rm|restart|pause` on a container named
  `cloudbot`, `cloudbot-cloudbot-1` or the same with a number. `docker compose`
  or `docker-compose` with a stop verb as the subcommand (`down`, `stop`,
  `rm` and so on) is refused when cloudbot is named anywhere in the command, as
  a project, a file path or a service. `docker compose exec cloudbot ...` passes.
- Any write into the unit folder `/etc/systemd/system`: a redirect, `rm`, `tee`,
  `mv`, `chmod` and similar tools with a path in it, `sed -i` there, and a copy,
  move or install whose destination is in it. Reading the folder passes, and so
  does a copy out of it. The Write, Edit and NotebookEdit tools are refused for
  any path in the folder.
- Any read, copy or search of the vault files. The vault file names are
  `vault.key` and `vault.json`. A word that starts with `vault` followed by a
  dot or a glob character is refused, such as `vault*` or `vault.k*`. The data
  folder is refused for any glob inside it, such as `/var/lib/cloudbot/v*`, and
  for the folder itself, except for listing programs: `ls`, `cd`, `stat`, `du`,
  `df`, `test`, `[`, `mkdir`, `chown`, `chmod`, `tree` and `echo`, and a `find`
  without `-exec`, `-execdir` or `-delete`. Copying the
  data folder with `cp`, `tar`, `rsync`, `zip` or `scp` is covered by that too.
  This applies in a Bash command and in the Read, Grep, Glob, Edit, Write and
  NotebookEdit tools. Grep and Glob patterns are searches, so they are not
  checked, but their paths and the Grep glob are.

The reason names the kind of command and never repeats the command, because a
command may hold a secret.

The floor is a floor, not a shell parser. It splits a command at separators
(including newlines and backticks), skips simple wrappers such as `sudo`, `env`,
`ionice` and `timeout` with their common value options and units, skips shell
keywords such as `then` and `do`, and checks the text of `sh -c`, `bash -c`
(also `-lc`), `su -c` and `eval` once more. The text after a here-string
(`bash <<< "..."`) and the text that `echo` or `printf` prints before a pipe
into `sh` or `bash` are checked the same way. Every part before such a pipe is
checked, and the shell may come after `sudo`, `env` or a path such as
`/bin/sh`. A command or file path longer than 20000 characters is refused
before anything else is read. A check that throws refuses the call with
"The command could not be checked." It does not see commands built at
run time, such as variables, `$(...)` or encoded text, arguments that `xargs`
builds, or a relative path after a change of folder. It does not parse `sudo`
options beyond the common ones. A mention of a vault file name inside quoted
text is also refused. The review model is still the check for everything the
floor does not name.

Known false positives, accepted: a word that starts with `vault.` or `vault*`
is refused even when it is not a vault file, such as `vault.notes.md`. Any
`pkill` with a cloudbot argument is refused. A command or heredoc that
mentions a refused command, such as a commit message, is refused too. A
`rm` of any file in `/etc/systemd/system`, not only cloudbot's, is refused.

Known gaps: a shell reading a file through a pipe, such as `cat script.sh | sh`,
is not read. Commands built at run time, listed above, are not seen.

## Bot mascot

Each bot has a mascot: a cloud body in one of ten colors and one of four shapes, drawn
in SVG by `src/web/components/CloudMascot.tsx`, with a white face. The color and shape are
columns of `bots` (`mascot_color`, `mascot_shape`, migration 0011), chosen at random by
`BotStore.create` and changed by the `profile_set_mascot` tool. `src/shared/mascot.ts` holds the palette.

The face comes from `deriveMascotState` (`src/web/mascotState.ts`), from what the app already
knows, in this order: a pending approval card (waiting), a running turn (thinking), composer text
(typing), a turn that just ended (done, for two seconds), a usage limit note (sleepy), and a known
error note (error). The error note is matched by its exact text: a limit stop, the stall stop, and
the two fixed turn errors. Any other note leaves the face idle. A turn the owner stopped gets no
done face. The web app has no event for a usage wait or a routine wait, so the usage limit note is
matched by its text. Only the selected bot shows the live face. The others show idle. Mascots beside
messages are always idle and do not track the pointer. On the sidebar and header mascots, the eyes of the
idle and typing faces follow the pointer through one shared window listener (`src/web/mascotPointer.ts`),
batched per animation frame.

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
