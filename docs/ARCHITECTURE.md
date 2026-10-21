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

`ModelStore` keeps one row per bot in the `bot_models` table, with a choice for
each kind of work: `chat`, `routines` and `review`. A null choice keeps the CLI
default. A choice is an alias the SDK accepts (`fable`, `opus`, `sonnet` or
`haiku`, listed in `MODEL_ALIASES`) or a full id that matches
`^claude-[a-z0-9.-]+$`. `parseModelInput` checks both. The routes `GET` and
`PUT /api/bots/:id/models` sit behind the session cookie. `PUT` replaces all
three choices, and a missing field clears its choice.

A turn sends its choice to the SDK `model` option. A routine turn uses the
`routines` choice and falls back to `chat`. The `source` of a turn (`chat` or
`routine`) is stored with the queued turn, so a routine that waits keeps its
choice after a restart. The review model is read with the owner rules on each
review call.

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
