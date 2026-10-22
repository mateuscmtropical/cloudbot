# Architecture

This page describes the target layout. Parts that do not exist yet are marked
as planned.

## Processes

| Process | Runs as | Job |
|---|---|---|
| Server | `cloudbot` user | HTTP API, chat, setup, vault, task queue, storage |
| Agent | `bot` user | The `claude` CLI for one conversation, started by the server |
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
which puts it in `/home/bot/.local/bin/claude`. The build then copies that binary to
`/usr/local/bin/claude` as root (mode 0755, owned by root) and deletes the bot's own
copies. The build fails if any file named `claude` is left under `/home/bot`, so bot,
which can write its home, cannot replace the binary that runs as the agent user. The
image sets `CLAUDE_PATH` to the root-owned copy, which the server starts for each turn. The agent environment sets `DISABLE_AUTOUPDATER=1`, so the
CLI does not update itself. Updates come with a new image. The build fails if
the CLI does not run. The runtime installs sudo and sets `CLOUDBOT_AGENT_USER=bot`.
`ClaudeCliEngine` reads that setting and `CLAUDE_PATH`, with constructor options
available for explicit configuration. Production startup fails if no agent user
is configured. Without an agent user, local development on Windows and macOS
starts the CLI directly.

With an agent user, the engine starts
`sudo -n -u bot -- /usr/local/bin/claude` with the CLI arguments as a
literal argument array. It passes the turn's working directory and cancellation
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
as one JSON-quoted line when the CLI exits with a failure. Workspace preparation failures
are logged on the server and reach chat as a short message without paths.

The wrapper constructs an environment containing only `HOME=/home/bot` and a
fixed system `PATH`. When the caller supplies the key proxy's
`ANTHROPIC_BASE_URL` in the runner environment, it also passes that URL and a
fixed dummy `ANTHROPIC_API_KEY`. It drops all other caller environment
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
permissions. The CLI is outside the bot home volume, so a new image replaces it.

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
    agent/         Runs one conversation turn through the claude CLI
    chat/          Chat routes, the turn run and the event stream to the web app
    createApp.ts   Hono app and routes
    desktop/       Starts the bot's desktop and starts it again when it exits
    main.ts        Entry point
    claudeAuth/    CLI subscription login sessions and sign-in status
    models/        Model choices per kind of work: validation and routes
    push/          Web Push: VAPID keys, payload encryption, sender and notifier, routes and the bot tool
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

### Local browser

Without the desktop, as in local development, the server starts an installed
browser of its own. `findLocalBrowser` in `src/server/desktop/localBrowser.ts`
looks for Chrome, Chromium or Edge in the usual install paths of Windows, macOS
and Linux. `CLOUDBOT_BROWSER_PATH` sets one path instead. With no browser found,
the browser tools stay off, and the bot is told it cannot browse.

With `CLOUDBOT_AGENT_USER` set, the local browser stays off. Chrome would run as
the server user, who can read the vault, and the agent user could reach that
through the DevTools port. The server logs why.

The browser uses `<data dir>/browser-profile`, never the owner's profile. Chrome
picks its DevTools port (`--remote-debugging-port=0`), on `127.0.0.1` only, and
writes it to `DevToolsActivePort` in the profile. Line one is the port and line
two is the socket path. The browser tools read the file on each action. A page
socket is used only when it is `ws:` on loopback, on that port, and its path is
the one on line two. Chrome gets only the variables it needs, not the server's.

The browser goes through the same `BrowserGate` as Docker, with the same flags
and `--disable-quic`. The gate listens on a free port, or on the port of the
last run when that one is still free. The port is kept in `cloudbot-gate-port`
in the profile. The server removes the port file when the browser it started
exits, and only when that browser wrote it. The server stops the browser on exit.

The browser tools stay off until a gate check passes. The check opens a
throwaway listener on a loopback port and has the browser load it. A pass needs
the gate's refusal, `ERR_SOCKS_CONNECTION_FAILED`, and no connection to the
listener. A connection means a policy bypasses the gate, and the tools stay off.
Any other error, such as a refused port, is not a pass, so the check retries and
then gives up. The check runs for a new browser and for a reused one.

A browser left open by a crash is reused only when it is ours. Its port must
answer on `127.0.0.1`, `/json/version` must name Chrome or Edge, the socket
path must match line two, and the command line (read with `SystemInfo.getInfo`)
must name this profile and the saved gate port. Each identity call has a 2 second
timeout, and the answer is capped at 64 KB. A port that answers but fails any
of these, or does not answer in time, is a leftover. The browser tools stay
off, no second browser starts on the profile, and the port file stays. Only a
refused connection marks the file as stale and removes it. The setup chat tells
the owner to close that CloudBot browser window.

The live view is a WebSocket at `/api/desktop/screencast`. `attachScreencast`
streams the page's JPEG frames from `Page.startScreencast`, and the owner's
mouse and keys reach the page only while the owner holds the screen. Pointer
positions up to 10000 pixels pass, so a page larger than the frame still takes
clicks. Queued moves keep only the latest. A button still down is released when
the screen goes to the bot or the panel closes. Both desktop sockets refuse an
`Origin` that is not this server's own host or the host of `CLOUDBOT_PUBLIC_URL`,
since the session cookie does not tell localhost ports apart. The panel asks
`/api/desktop/view` which view to use.

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
yet. `BotStore`, `MessageStore`, `SettingsStore` and `PushSubscriptionStore` wrap the tables.

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
`http://<HOST>:PORT` otherwise. That is `127.0.0.1` by default, and `localhost` when `HOST`
is a wildcard address such as `0.0.0.0`. `buildSetupLink` in `setupLinkUrl.ts` builds
it for both the server start and the `setup-link` entry point. The cookie is
`Secure`, so the link works only on localhost or over HTTPS.

The server listens on `HOST` and `PORT`. `HOST` defaults to `127.0.0.1`, so a local run
is not open to the network. The Docker image sets `HOST=0.0.0.0`, because Caddy reaches the
server from another container, and compose does not publish the server port. The start log
prints the address the socket really got.

A request that changes state (`POST`, `PUT`, `PATCH` or `DELETE` under `/api`) passes
`requireSameOrigin` before the session check. The cookie does not tell localhost ports or
sibling subdomains apart, so the `Origin` must name the server's own host or the host of
`CLOUDBOT_PUBLIC_URL`. A request with no `Origin` passes only when the browser marks it
`Sec-Fetch-Site: same-origin`, and any other `Sec-Fetch-Site` value is refused. A
refusal is a 403. A request with a body must have the content type `application/json`,
or `multipart/form-data` on the upload route, and anything else gets a 415. A request
without a body needs no content type. So a script that calls the API without a browser
must send an `Origin` header. The two screen sockets keep their own `Origin` check.

Every response carries a Content Security Policy that allows only the app's own files,
`data:` images, `object-src` and `base-uri` of none and `frame-ancestors` of none. Its
`connect-src` also names `ws://` and `wss://` for the request's own host, and for the host of
`CLOUDBOT_PUBLIC_URL`, because older Safari does not match `'self'` to a WebSocket. It also
sends `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` and the
cross-origin opener and resource policies of `same-origin`. HSTS stays with the proxy.
The code is in `access/securityHeaders.ts`.

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
returns it. Every turn passes the folder to the CLI as an additional directory,
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

Images up to 5 MB go to the CLI as image blocks, built from the bytes in memory.
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

## Connected apps

`app_connect`, `app_list` and `app_remove` in `src/server/apps/` let the bot connect a remote MCP
server by its address. `checkAppUrl` accepts only http and https, with no user name or password. It
resolves the host and refuses any address that is not public, unless the host is on the browser
allow list, which is the same guard as the browser gate. A token is a vault secret saved with the
secure form, under the bot that asked for it. Its site must match the origin of the server, and a
token goes only to an https address. `probeAppServer` runs the MCP handshake over plain JSON-RPC and
counts the tools. The rows in `connected_apps` keep the name, address, status, tool count and the
secret name, never the token.

The turn does not give the agent the server address or the token. `AppProxy` listens on 127.0.0.1
and forwards each request to the server with the token read from the vault. Each server has a random
key in the proxy address. The proxy checks the address again on every request, so a DNS answer that
changes cannot reach a private host. The address of a connected server is kept in memory, and
`ConnectedApps.start` registers the stored servers again after a restart.

The tools of a connected server are named `mcp__<name>__<tool>`, so they go through the approval
path like other outside connectors. `app_connect` always asks the owner. The owner removes a server
in the Connect apps panel through `GET /api/apps` and `DELETE /api/apps/:id`.

## API integrations

The bot writes a script in its workspace and registers it as an integration. An integration is a name, an entry file, a command and at most one secret.

- The command is one of `node`, `python3` or `bash`. The script goes in on stdin, so the bytes that run are the bytes that were hashed.
- The entry file must be a path inside the bot workspace. A path with `..`, an absolute path, or a link that leads out is refused. The file is opened without following links, and it must be a regular file.
- The script is at most 8000 bytes. The approval card shows all of it, so a longer script is refused at create, update and run. The bot must keep scripts short.
- A script with a control character, a bidi override, a zero-width or invisible character, or a line separator (U+2028, U+2029) is refused. Tabs and LF line breaks are allowed. Such characters could make the card show other text than the script.
- A carriage return is refused too, including in CRLF files. A lone CR ends a `//` comment in JavaScript and Python, so the card would show a comment that the code does not have. Save the script with LF line endings.
- `integration_create` and `integration_update` take the sha256 of the entry file, which the bot computes with `sha256sum`. The server refuses the call when the file has another hash.
- The approval card shows the name, the entry file in JSON quotes, the command, the secret with the site it belongs to, the sha256 and the whole script. For an update, the card shows the values the change would save. A field that is not given keeps its stored value.
- The server denies a create or update whose card cannot be built. That covers an unreadable file, a hash that does not match, a missing integration, and a script that fails the checks. The owner never sees an approve button for a card without its script.
- The owner approves each change that passes. The run then checks the file against the stored hash. A changed file does not run until the owner approves the new version.
- `integration_run` goes through the review like a shell command. `integration_list` needs no review. `integration_remove` goes through the review too.
- The integration runs as `cloudbot-integrations`, its own system user. That user cannot read the vault, the workspaces or the bot's shell. The integrations are on only when both `CLOUDBOT_AGENT_USER` and `CLOUDBOT_INTEGRATION_USER` are set. The log says why they stay off otherwise.
- Each run starts `sudo -n -u cloudbot-integrations -- /usr/bin/env -i PATH=... HOME=/var/lib/cloudbot-integrations /bin/bash -c <wrapper> cloudbot-integration <SECRET_NAME> <command> <args>`. The argv holds the name of the variable, never its value.
- The secret goes in the first line of stdin, then the script. The wrapper reads that line, exports it under the variable name and execs the interpreter. The script stays on stdin after the first line, because bash reads a pipe one byte at a time. A secret with a line break is refused.
- Before the command starts, the wrapper sets `ulimit -u 256` (processes and threads of the user, node alone starts about ten) and `ulimit -f 65536` (file size, 64 MB). If a limit cannot be set, the run does not start.
- Names the environment or an interpreter reads are refused as secret names. Examples are `PATH`, `HOME`, `IFS`, `NODE_OPTIONS`, `BASH_ENV`, `PYTHONPATH`, and any name that starts with `LD_` or `BASH_FUNC`.
- Runs go one at a time, because every run shares one user. Before each run and after it, the server kills that user's processes with `pkill -KILL -u`. Then it deletes the user's files in its home folder, in `/tmp`, `/var/tmp` and `/dev/shm`, and its SysV message queues, semaphores and shared memory. A process left by one run does not reach the next.
- Each run has a timeout of 60 seconds and an output cap of 64 KB. At either limit sudo gets SIGTERM, and SIGKILL after 2 seconds if it has not exited. The output is read 0.5 seconds after sudo exits, so a process that keeps a pipe open cannot hang the run.
- The secret is removed from the output before it reaches the model, the run log or the database. The removed forms are the plain value, hex in both cases, URL-encoded, and base64 and base64url at each of the three alignments. When the output was cut, or the run timed out, a partial match at the end is removed too. This is best effort. The approval card is the real control, because the owner reads the whole script before approving it.
- The run log keeps the last 20 runs of each integration, with the time, the exit code and up to 2000 characters of output.

Setup. The Docker image creates the user `cloudbot-integrations` with the home `/var/lib/cloudbot-integrations`, sets `CLOUDBOT_INTEGRATION_USER`, and sudoers allows the server user to start processes as that user with `/usr/bin/env -i` only, with no password (`docker/cloudbot-agent.sudoers`). The image has `procps` for `pkill` and `util-linux` for `ipcs` and `ipcrm`. Outside Docker, create the same user, install those packages, and add the same sudoers line.

Limits. The sudoers line allows any program that starts with `/usr/bin/env -i`. The cleanup commands run through that line too. So the server user can run any command as `cloudbot-integrations`. The wrapper limits what the bot asks for, not what the server runs. An approved script can still send its secret to any address it can reach. The server reads the entry file to check its hash, so the server user needs read access to the workspace. The sudo path has not yet been run end to end on a real host.
## GitHub

The bot's `git` and `gh` reach GitHub only through `GithubProxy`. The bot's shell never holds the
token. The owner saves it as the bot secret `GITHUB_TOKEN` in the secure form, with the site
`https://github.com`. A token saved for another site is never sent.

Each bot gets its own HTTPS listener on 127.0.0.1 with a random port. The port is the bot's address,
and the turn adds it to the agent environment. `gh` gets `GH_HOST` with that address, and
`GH_ENTERPRISE_TOKEN` as a dummy, because `GH_TOKEN` only works for github.com. `git` gets
`insteadOf` for `https://github.com/`, so clones and pushes go through the proxy. The listener uses a
self-signed certificate for 127.0.0.1 that is made at start. The key is made in Node and lives in the server's
memory. For the moment openssl reads it, it sits in a folder only the server user can open, and that folder is
removed right after. Two public files are
written to a folder the bot can read: the certificate, which `http.<proxy>.sslCAInfo` trusts for the proxy
address, and a bundle of the system roots plus that certificate, which `SSL_CERT_FILE` points to, so curl,
pip and other tools in the shell keep their usual trust. Without openssl, GitHub routing is off and the
server logs one line.

The proxy forwards only three kinds of address: git smart HTTP for `github.com`, the REST API under
`/api/v3/` and GraphQL under `/api/graphql`, both to `api.github.com`. The upstream host comes from
constants, so a request path cannot pick another host. It replaces any `Authorization` header with the
token, as Basic auth for git and as Bearer for the API. Redirects are not followed.

Reads pass without a card: clones, fetches, GET requests and GraphQL queries. A push (`POST` to
`git-receive-pack`), a REST `POST`, `PUT`, `PATCH` or `DELETE`, and a GraphQL mutation wait for the
owner in the chat. The card names the change. A push lists each ref as "create", "update" (with the old
and new short hashes, since a force push cannot be told apart) or "delete", read from the ref commands at
the start of the push. A REST write shows its method and path on the first line, then the whole body. A
GraphQL mutation shows the whole query and the other request fields, pretty printed. The card never cuts
text. A change whose card is over 6000 characters, or that has a control, bidi or zero-width character,
gets a 403 and is not sent. A denied request gets a 403 with `{"error": "..."}`. Only one card is open per
bot. A write while one is open gets a 429 that says so. A push or a write with no token saved gets a 401
that names `GITHUB_TOKEN`, and the owner is not asked. Git prints only "could not read Username" for that
case, so the bot should read the message of `gh` or ask the owner to save the token.

`gh` inside a clone must name the repository, with `--repo owner/repo` or `GH_REPO=owner/repo`.
Without it `gh` fails with "none of the git remotes ... correspond to the GH_HOST environment
variable". It does not reach GitHub on another route. The remote shows the proxy address, but gh
compares the remote host with `GH_HOST` and the port breaks that match.

Each bot has its own port, but all bots run as the same Linux user. Any process of that user can read
the environment of another bot's shell, and so learn its port. A read then reaches GitHub with the
token. The approval only covers writes. A proxy key cannot fix this, because `gh` cannot send one.

The Docker image installs `git` and `openssl`, and `gh` from GitHub's apt repository. The
sudoers file keeps the `GH_*`, `GIT_*` and `SSL_CERT_FILE` names, because sudo drops every other name
from the agent's environment.

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

## Sensitive data

`src/server/sensitive/` finds three kinds of number. A payment card number has 13 to 19 digits, has a known brand prefix and length (Visa 16 or 19 digits, Mastercard 16, Amex 15, UnionPay 16 to 19, Maestro 12 to 19, and the others in `sensitiveNumbers.ts`), passes the Luhn check, and may have up to two spaces, dots, dashes, underscores, slashes or non-breaking spaces between groups. A run right after `+`, `tel:` or `wa.me/` is not a card. A run inside a hex id of 32 characters or more, such as a git sha, is not a card. Zero-width characters are removed before matching. A CPF has valid check digits and is either in the dotted form (ddd.ddd.ddd-dd) or 11 plain digits right after the word CPF, so phone numbers are not taken for one. A US Social Security number has the dashed form, and areas that are never issued are not matched.

- `ApprovalGate.review` checks each tool call first, before the reviewer and the classifier, so every engine gets the check. A call is outbound when it is browser typing or opening, `bot_send`, `integration_run`, `watch_create`, `bot_create`, `routine_create`, `WebFetch`, `WebSearch`, any outside connector tool, or a Bash command that sends data (curl with a body, a mail command, or a GitHub CLI write). A call that is outbound and holds such a number is refused with a short reason.
- The reason names the kind of number and never the number. It tells the bot to ask the owner for the value with `request_secret`. The owner sees the reason on the tool's line in the chat. `request_secret` itself is not checked, because its value goes through the secure form.
- `share_file` scans a text file of up to 5 MB and copies the same bytes it scanned. Binary files and bigger files are copied without a scan.
- The GitHub proxy refuses a request whose body holds such a number, for any method. Git smart HTTP paths (`info/refs`, `git-upload-pack`, `git-receive-pack`) are not scanned, because their bodies are packs. A push is shown to the owner by its refs.
- Bot text is masked where it is stored and where it streams. All digits except the last four become `*`. The stream masker holds back a trailing run of digits and spaces until the text after it arrives, so a number that comes in pieces is masked too. A CPF label is held back too, so a streamed CPF is masked live. The held digits are cleared when a turn starts and when it ends, so nothing crosses into the next turn. Only the bot's text and its tool summaries are masked.
- Health and personal finance details, and page text that asks the bot to send data elsewhere, have no pattern. The system prompt and the review prompt cover them.

Known gaps: the body of a file passed to a Bash command is not scanned, only the command text. Bash coverage is best effort: only curl with a body, wget with post, mail commands and GitHub CLI writes are seen, not other ways to send data from a shell, such as python or nc. A number split across two tool calls, such as one call per group, is not seen. Other message kinds, such as choices and links, are not masked.

## Owner rules

`RuleStore` keeps the owner's rules in the `bot_rules` table. Each row has the
bot, a kind (`allow` or `block`), a sentence and a list of blocked tools. The
routes `GET` and `POST /api/bots/:id/rules` and `DELETE
/api/bots/:id/rules/:ruleId` sit behind the session cookie. `parseRuleInput`
checks the input: a sentence of 1 to 300 characters, at most 20 tool names as
the CLI spells them, optionally with a pattern such as `Bash(rm:*)` without
commas. Only a block rule can name tools, and a bot has at most 50 rules. The
bot has `rule_list` to read its rules. It also has `rule_change` to propose adding
or removing one, and that tool is offered only with the approval gate. Rules are
permissions, so `rule_change` always asks the owner in the chat and shows the rule
on the card. A misspelled tool name blocks nothing, so the sentence carries the
intent.

The web app shows them in `RulesPanel`, opened with the Rules button in the
conversation header. It lists, adds and removes rules through these routes and
shows the server's error text when a rule is refused.

Each turn reads the bot's rules. `buildSystemPrompt` lists the sentences as
owner rules, and the blocked tools go to the CLI as `--disallowedTools`, which
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
means no helper agent. A choice is an alias the CLI accepts (`fable`, `opus`,
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

A turn sends its choice to the CLI `--model` option. A routine or webhook turn
uses the `routines` choice and falls back to `chat`. The `source` of a turn
(`chat`, `routine` or `webhook`) is stored with the queued turn, so a turn that
waits keeps its choice after a restart. The review model is read with the owner
rules on each review call.

The effort follows the same rule (`chooseTurnEffort`) and goes to the CLI
`--effort` option. The review call gets the review effort, and each helper gets
its own effort in the `--agents` file. An unset effort is left out, so the
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
- Steps: the CLI `--max-turns` option. The CLI reports `error_max_turns`, which
  becomes a `turn_limit` event with `limit: 'steps'`.
- Spending: the CLI `--max-budget-usd` option, reported as `error_max_budget_usd`.
  The CLI `total_cost_usd` covers the main loop only, so the review agent cost
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
the clock. The CLI does not report the main-loop cost while a turn runs, so the
two costs are never added together. The helper agents' cost is assumed to count toward
`--max-budget-usd`, and this is not checked at runtime.

## Stalled turns

A turn that sends no agent event for 10 minutes is stopped. The period is the
constant `STALL_MS` in `src/server/chat/StallWatchdog.ts`, not a setting.
`StallWatchdog` starts with the turn, and it starts again on each agent event of
the turn. An `activity` event counts too. The runner sends it for a CLI message
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

## Task board

Each bot has a board of tasks in the tasks table: id, bot_id, channel_id (empty until group channels exist), title, status (todo, doing, blocked, done), blocked_reason and timestamps. Three tools in the profile server manage it: task_add (never Blocked), task_move (Blocked needs a reason) and task_board. They are skipped by the approval gate, since they only change the bot's own notes and the owner asks for them in the chat. A move into Blocked from another column saves a notice in the bot's chat. The notice starts with "Task blocked by this bot:", is labeled as the bot's own note for the review, and quotes the title and reason with markdown escaped, so no link renders. A bot can have at most 100 open tasks, and finished tasks do not count. task_board shows open tasks first, newest first, up to 50. task_board posts a tasks message, a snapshot that does not change after it is posted. The owner moves tasks only through the chat. There are no panels or header buttons for the board, and no unread dot for other bots: the bot list only marks the bot that is open.

### CLI engine gate and known limits

The CLI engine (`ClaudeCliEngine`) runs `claude -p` with one gate. The per-turn settings ask for every built-in and every MCP tool, and `--tools` lists only the built-ins the bot uses, so a built-in that a later CLI adds does not run. Each ask goes to the permission prompt tool `mcp__cloudbot__approve`, which answers from the owner review. Each tool use gets one decision and one run at most, and the decision is bound to the tool use id the CLI printed on its stdout. The prompt tool is hidden from the model with `--disallowedTools`.

Limits:

- Turns of one OS user can read each other's turn folders, since the CLI and its tools all run as that user. In local mode that is the owner's user. In agent-user mode every bot runs as the same user, so bots can read or delete each other's turn folders. This is denial of service or timing, not a bypass: a decision still needs the turn's token, and the seen-id check stops a stolen token from getting a decision for a call the CLI did not make. The later fix is one OS user per bot, or the token sent over stdin instead of a file.
- A tool outside the gate runs unreviewed. That happens if a built-in is missing from `BUILTIN_TOOLS`, or if an MCP server's ask rule does not match its tools. Keep the list in step with the CLI, and test each remote MCP server through the gate before trusting it.
- If the server crashes, a command already approved keeps running until it ends. New tool calls fail closed, because the prompt tool is unreachable. The CLI exits once its input closes, after its current turn. Run the server under a supervisor that kills the agent's process group, as Docker does on stop.
- `disallowedTools` matches by exact name on the decision route. The CLI applies the same list itself.
- A malformed approve reply stalls the turn until the probe guard ends it, with no tool run. Our server never sends one, so this is accepted.
- Remote MCP tools prompt by default. The `mcp__<name>` ask rule is kept as well. The probe with a second MCP server confirmed that the prefix and exact forms both reach the prompt tool, and that a denied call does not run.
- CLAUDE_CONFIG_DIR: in local mode, login, status, sign-out and turns all use `<data dir>/claude-config`. In agent-user mode, they all run as the bot user with its default home config (`/home/<agent>/.claude`). The variable is not forwarded through sudo, so the bot user's own config is the only one read.
- The workspace `CLAUDE.md` is the bot's memory. The CLI does not load it under `--setting-sources ''`, which keeps bot-writable settings files out, so the server reads it each turn and appends it to the system prompt file, after the bot profile. The bot controls that folder, so the read opens with `O_NOFOLLOW` and `O_NONBLOCK`, and takes only a regular file, cut at 64 KB. A link, pipe, device or folder means no memory, and the server logs one line without the path. The block is labelled as the bot's own notes, not the owner's words, between begin and end markers. Checked live with the real CLI: the marker in the file reached the request body.
- On POSIX, a stop and a clean exit both send KILL to the CLI's process group. The group does not hold a command that starts its own session, such as `setsid sleep 300 &`. So each turn also gets a random `CLOUDBOT_TURN_MARKER` in its environment, which every child inherits. When the turn ends, every process that still carries the marker is ended (#165). Local mode on Linux reads `/proc/<pid>/environ` of the server user's processes. Agent-user mode runs the root-owned `/usr/local/bin/cloudbot-end-turn` as the bot user through sudo, so it can only read and end the bot user's processes. It takes only a 32 character hex marker. Checked live with the real CLI: a `setsid` sleep started by an approved Bash call was left running before, and is gone now. Limits: a process that clears its environment (`env -i`) loses the marker and is not found. macOS has no `/proc`, so nothing is ended there. The kill goes to the group only, not to a bare pid. A group id can be reused once its group is empty, so a clean exit followed by a fresh group with the same id could be hit. The window is tiny but not zero.
- Windows (local mode only, no job object): a stop skips TERM, because it would end the CLI alone and `taskkill /T` could no longer find its tools. It runs `taskkill /T /F` while the CLI is still alive. Checked live: the CLI, the tool process and its child were all gone when the turn ended. After a clean exit, nothing is sent, since the exited pid may be reused. The background child was already gone in the live check.
- Agent-user mode: the group signal goes through `/usr/local/bin/cloudbot-signal-group`, a root-owned wrapper that accepts only a positive group id and TERM or KILL. The sudoers line allows only that wrapper. The wrapper was checked as a non-root user. The sudo path itself is not verified: WSL asks for a password, so no passwordless sudo test was run.

### Codex engine (not wired yet)

`CodexEngine` runs a turn in its own `codex app-server`, the Codex route with an approval channel (`codex exec` has none). It is built and tested but no bot uses it yet. The rest is tracked in #128.

- Every thread starts with the approval policy `untrusted` and the `workspace-write` sandbox. With `on-request`, most commands run without a question.
- The built-ins that have no per-call approval are turned off with `-c`: `web_search="disabled"`, `features.view_image=false`, `features.multi_agent=false` and `features.goals=false`. `shell_environment_policy.exclude=["CLOUDBOT_TOOLS_TOKEN","CODEX_HOME"]` keeps both variables out of every shell command. The model is then offered only `exec_command`, `write_stdin` and `request_user_input`.
- A command approval goes to the same review as a Claude `Bash` call, with the command taken out of the login shell Codex wraps it in. A command that runs outside the workspace is reviewed as `cd <folder> && <command>`. Each file of a patch is reviewed as the `Write` or `Edit` it is, so the command floor checks its path. A write to a running command's input is declined.
- A command or file change that names the Codex home or a `.codex/` folder is declined without a review. Every path of a file change is resolved against the workspace, then through the nearest existing ancestor and its real path, so a relative path, `..` or a symlink cannot hide the Codex home or a project `.codex` folder. A path that cannot be resolved is declined, and a move is checked at both its old and new path. The command text and its `cwd` are checked after the login-shell wrapper is removed. The reason is that Codex loads its config and sign-in from the Codex home, and a project `.codex` folder once the project is trusted. A write there could make Codex run a program without a review next turn. This is a floor, not a parser. A path that a command builds at run time is not covered. The Codex sandbox and the review are.
- An approval that would give more than one run is declined without a review: a retry outside the sandbox (it has a `reason`), a network host or network rule, and a file change with a `grantRoot`. A plain approval has none of these fields.
- A patch that Codex replaces while it is reviewed (`item/fileChange/patchUpdated`) is declined, since the accept would apply changes nobody saw. A stop before or during a review also declines, even when the review allowed the call.
- The step limit counts the approvals. Past it, the command or file change is declined and the engine ends the turn.
- The bot's own tools are served by the loopback server, set for Codex with `default_tools_approval_mode="prompt"` and the token in `CLOUDBOT_TOOLS_TOKEN`, never on the command line. Each tool call then comes as an MCP question that names the server and the arguments but not the tool. It is matched to the one started call of the bot's server with the same arguments. No match or more than one is a decline. The review decides, and an allowed call may run once in the loopback server, bound to the `callId` Codex sends with `tools/call`. The prompt tool of the Claude engine is not listed for Codex.
- Anything else Codex asks is declined or refused: questions from other MCP servers, token refreshes, questions for the user and requests the engine does not know. A review that fails or takes longer than 65 minutes declines the call.
- Each bot gets its own `CODEX_HOME`, made by CloudBot with mode 0700, and a separate `HOME` beside it (`<codexHome>-home`, also 0700), so `~` cannot lead to `config.toml` or `auth.json`. The app server gets `PATH`, `HOME`, `CODEX_HOME`, the engine's own environment option and the turn's extra variables (such as the GitHub proxy). `HOME` and `CODEX_HOME` are set last, so neither the engine option nor the turn can replace them. It never inherits the environment of the CloudBot server. Any other variable given to the engine does reach the commands, so no secret may go there. The canary checks that the loopback token never reaches a command.
- Codex reads a project config at `<workspace>/.codex/config.toml` only when the project is trusted, through `projects."<path>".trust_level = "trusted"` in `$CODEX_HOME/config.toml`. CloudBot does not write that entry, so project config is off. No `-c` override or flag turns it off when it is on: Codex builds the trust map from the user config before it looks for project config, and the dot-separated `-c` syntax cannot name a project path key. This was checked against codex-cli 0.163.0 and its config loader.
- A stop sends `turn/interrupt`, closes the input, then sends TERM and KILL to the process group like the Claude engine.
- `pnpm canary:codex` runs the real binary against a fake model server on 127.0.0.1. It checks the offered tools, that seven commands and a file edit all reach the review and none runs, that `view_image` is refused, and that a refused bot tool never runs while an allowed one runs once. Set `CODEX_CANARY_PATH` to the binary. CI runs it in the `Codex canary` job with the pinned version, and a unit test keeps that version equal to `CODEX_PROTOCOL_VERSION`, so an upgrade changes both. The engine was checked against codex-cli 0.163.0.

With any MCP server, Codex also offers `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`, with no approval. The loopback server has no resources, so they read nothing.

Not covered yet: commands that Codex starts in their own session may outlive a stop, as with the Claude engine (#165). Also outside MCP servers, images, the spending limit (Codex reports tokens, not dollars), the owner's model choices, the agent user, sign-in and the setup choice.

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

A helper is a CLI subagent, written to the `--agents` file, with its own model. `browsing` gets the browser
tools (`BROWSER_TOOL_FULL_NAMES`) and exists only when the bot has a browser.
`documents` gets `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep` and
`share_file`. `buildHelperAgents` builds the `agents` option for the turn. A
helper exists only when its model choice is set. The main turn then also gets
the `Agent` tool in `allowedTools`, and one line of the system prompt per
helper tells it to hand that work over.

Safety for helper calls rests on two things. The owner's blocked tools go to
each helper as its `disallowedTools`, and to the turn as `--disallowedTools`.
The turn's approval route also covers the calls a helper makes. Not checked
against a live CLI for helpers: that the CLI enforces a helper's own
`disallowedTools`, and that every helper call reaches the approval route.

## Tool call approval

`ApprovalGate` pauses a tool call until the owner answers. `ClaudeCliEngine`
gives each call that needs a decision to the loopback approval tool, which the
CLI calls with `--permission-prompt-tool`. `reviewToolCall` decides the call, and
the answer goes back to the CLI. Each tool call gets one decision and one run at most.

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
  `browser_scroll`, `request_screen`, `request_secret`, `share_file`, `update_profile`,
  `notifications_enable` and `notifications_disable`.
- A connector tool (`mcp__` but not the bot's own server) whose tool name (the part after the server name) has the
  word send, reply, purchase, buy, pay, checkout, book, booking, reserve or
  order always answers `ask`. The model is not consulted.
- A `Bash` command that mails or sends data out (`sendmail`, `curl` with a
  body or a method other than GET, `wget --post`) also always answers `ask`.
- A call whose input is longer than 10000 characters answers `ask`, because
  the model must see the whole input.
- Every other call goes to the model.

The model is one `claude` CLI call with no tools, no settings files, no
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
  `vault.key` and `vault.json`. The push key file `push-vapid.json` is refused the same way, by name, by a glob and in the data folder. A word that starts with `vault` followed by a
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

## Notifications

The web app is installable. `src/web/public/manifest.webmanifest` names it CloudBot and points at the mascot icons `pwa-192.png` and `pwa-512.png`. `src/web/public/sw.js` is the service worker. It caches nothing and makes no request. It only shows push notifications and opens the right bot when one is tapped. The server serves both files from the web folder. `sw.js` is sent with `Cache-Control: no-cache`, so a new version is picked up at once. Service workers and push need HTTPS or localhost. On an iPhone, the app must be added to the home screen first.

There is no settings panel. The owner asks a bot in the chat. The bot calls `notifications_enable` (`push/createNotificationTools.ts`), and `ChatService.postNotificationCard` posts a choice card with `isNotificationOptIn`. The card says what is sent. The browser permission prompt needs a click, so the card button calls `enablePushNotifications` (`src/web/pushClient.ts`) first thing in the tap, before any await. It then subscribes with the server public key, sends the subscription to `POST /api/push/subscriptions` and shows a confirmation. The tool is on the skip list of the reviewer, since it only posts a card. The system prompt tells the bot about the tool only when the server has it.

Turning them off works the same way. `notifications_disable` posts a card with `isNotificationOptOut` and the buttons "Turn off notifications" and "Keep them". The button calls `disablePushNotifications`. It sends `DELETE /api/push/subscriptions` with the endpoint of this browser, and only then unsubscribes the browser. If the server call fails, the browser keeps its subscription and the card stays open. Other browsers keep theirs until the owner does the same there. The tool is on the skip list too.

### Web Push without a dependency

The server speaks Web Push with `node:crypto` and does not use the `web-push` package. The payload encryption is RFC 8291 (`aes128gcm`, ECDH P-256, HKDF, one record) and the sender proof is VAPID, RFC 8292 (an ES256 token in the `Authorization` header). Both are in `push/webPushCrypto.ts`, about 150 lines. A test checks the encryption against a known answer from the independent `http_ece` library, so it is not only checked against itself.

Every record is padded (RFC 8188, zero bytes after the delimiter) to a multiple of 512 bytes, so each push is 614 bytes whatever the notice says. The push service and anyone on the path see the same size every time. The largest payload is 4096 - 86 - 17 bytes, so the whole body stays inside the 4096 bytes that push services accept. The bot name in the title is cut to 40 characters, which keeps every notice in one block.

Why not `web-push`. It adds a dependency tree that runs with the server's rights and makes the network call itself, so CloudBot could not pin the connection to a checked address. The protocol is small and fixed. The cost is that CloudBot owns the crypto code. The tests and the known answer are the guard for that.

### Keys

`push/loadVapidKeys.ts` makes one VAPID key pair on first start and writes it to `push-vapid.json` in the data folder with mode 0600 (the `wx` flag, so an existing file is never overwritten). Only the public key leaves the server, through `GET /api/push/key`. The key file is on the command floor next to the vault files. Keys are never logged and never reach the model. If the file is lost, every browser must turn notifications on again, since a subscription is tied to the key that made it. The client checks this and subscribes again when the key differs.

### Where a push may go (SSRF)

A subscription holds an endpoint URL that the browser chose, and the server would call it. So the endpoint is a request that an attacker with the session could aim at an internal address. Two checks guard it, in `push/pushEndpoint.ts` and `push/createPushSender.ts`:

- The keys of a subscription must be base64url text of the exact size a browser gives: 87 characters for the key and 22 for the secret. Anything else is refused before the encryption is tried.
- An allowlist of the push services that browsers use: `fcm.googleapis.com`, `push.services.mozilla.com`, `push.apple.com` and `notify.windows.com`, each with its subdomains. The endpoint must be https on the default port with no credentials. It is checked when the subscription is saved and again before each send.
- The host is resolved and every address must be public (the same `isPublicAddress` rule the other outbound calls use). The request then goes through `pinnedFetch` with that address, so a DNS change between the check and the call cannot redirect it.

The allowlist alone would cover the risk. The address check is a second layer in case a name on the list ever points inward. The cost is that a self-hosted push service, such as UnifiedPush, does not work. Adding one means adding its domain to the list.

### Events and payload

`ChatService` reports an owner notice through the `notifyOwner` option in three cases: a turn finished (not for a Stop, not for a turn that a webhook started, and not when the turn waits on a usage limit), an approval card was posted, and a screen hand-off was requested. A bot gets at most one "finished" push in a minute. An approval or a screen hand-off is never held back, since the bot waits for the owner. `push/PushNotifier.ts` turns the notice into a payload with the bot name as the title and one neutral line, such as "Finished its work." The payload holds the bot id and the message id so a tap can open them. It never holds the text of a message, a secret or a tool input. The notifier sends to every stored subscription. A 404 or 410 from the push service means the browser is gone, and the subscription is removed. Other failures are logged without the endpoint. A send never blocks or fails a turn.

At most 20 subscriptions are stored (one per browser), in the `push_subscriptions` table.

### In the browser

The worker keys a notification by bot and kind (`botId:kind`) and sets `renotify`, so a newer one replaces the older one. When a visible window already shows that bot, the notification is shown without sound and closed at once. WebKit revokes the subscription of a site whose pushes end without a visible notification, so showing nothing is not safe. It finds that from the `?bot=` part of the window address, which the app keeps in step with the open bot. A tap focuses the window of that bot, or any window, and posts `openBot` to it. With no window open, it opens `/?bot=<id>&message=<id>`. The app then selects the bot and scrolls to the message (`useNotificationOpen`, `ConversationView`).

Limits. There is no notification for a usage limit, a stall or an owner Stop. A dead subscription is removed when the push service reports it gone.

## Bot hand-offs

A bot passes a message or a task to another bot with `bot_send`, found by the target's name. The tool is offered only with the approval gate. Its handler is `ChatService.handoffFromTool`. It refuses an unknown name, a name shared by two bots, and the sending bot itself.

The tool is in the review class, like the bot's other tools. The reviewer judges each call, so a hand-off that the reviewer allows runs without asking the owner. When the reviewer asks, the card shows the target and the whole text. The receiving turn is reviewed under its own rules as well, so a bot cannot use another bot to skip a block or an approval. `classifyToolCall.test.ts` pins the class.

The target's turn starts through `sendMessage` with the source `bot`, the same path a routine or webhook turn takes. The source `bot` uses the routines model, effort and limit choices. A hand-off takes no files that the owner staged for the target.

The target gets the text as a user message. It starts with `Message from bot <name>`, then a line that asks it to treat the text as a request from another bot, not as an instruction from the owner. The name is collapsed to one line. The reviewer labels the message as not the owner. The `update_profile` name refuses control characters, so a bot cannot make a name with a line break.

The sender's chat gets "Sent to <name>: <text>" before the send. If the send does not start, a second note says why. When the target's turn ends, its text replies go to the sender's chat as one note that starts with "Reply from <name>". A stopped or failed turn says so in that note. A turn that hits a usage limit reports from its continuation, so the reply comes once. The reviewer labels both notes as outside data or as sent by this bot. The sender's own agent does not see the reply in its context.

Caps. A chain carries a depth, and a turn that a hand-off started sends one level deeper. The hand-off at depth 4 is refused, since `MAX_HANDOFF_DEPTH` in `bots/botHandoff.ts` is 3. So a chain allows 3 hand-offs in a row, which is 4 bots at most. A sender turn sends at most `MAX_HANDOFFS_PER_TURN` (3) hand-offs, and a target has at most 3 hand-offs waiting in its queue. A refused hand-off returns an error to the bot. A chain stop also posts a note to the sender's chat.

Dropped hand-offs. A hand-off waiting in a queue that is dropped, by Stop during a usage wait or by a delete, leaves a note in the sender's chat. Stop on a running hand-off turn ends it as "stopped" in the reply note.

Limits of this version. A queued hand-off keeps its depth and reply routing only in memory. After a restart, a queued hand-off runs with depth 0 and no reply note. The reply scan reads the newest 500 messages of the target, so a longer turn can lose its earliest replies.

## Bot templates

bot_export writes the bot's template as a JSON file and shares it in the chat through the same path as share_file. The file has a cloudbotTemplate version (1), the name, title, description (empty when the bot has none), look, rules (kind, text and blocked tools) and routines (name, prompt and schedule). Nothing else is read from the bot, so sessions, secrets, webhook addresses, uploads and learned memory never reach the file.

bot_import reads a file the owner attached in the chat. The path must resolve inside the bot's own upload folder (uploadDirFor(botId)), so a bot imports only files from its own chat. The file is at most 64 KB and is parsed with a strict schema: unknown keys, other versions, control or hidden characters and values past their caps are refused. Line breaks and tabs are kept in the description, rules and prompts. A Windows line end is read as a line break. Each blocked tool name must have the format the owner's rule tool uses. No registry of tool names exists in this version, so a name in that format is accepted.

The review card shows the whole template. Names, titles, rules, prompts and descriptions are JSON-quoted on the card, so a line break cannot start a new section. Each routine shows its schedule. Each card keeps the SHA-256 of the file it showed. The import takes the card with the same digest, and that card is then gone. A newer card for the same path replaces the older one. A card expires after ten minutes. The tool call carries no id and the approval gate has no deny hook, so a denied card is not removed. It expires instead.

Imported routines start turned off, and the bot gets no secrets. A secret it needs goes through the secure form as usual. The rules are added in file order, one at a time.

Skipped in this version: the template does not carry the bot's shared files, its learned memory, or any routine state such as its last run.

## Bots

The "+" button calls `POST /api/bots`. The server makes a bot named "New bot" and posts a question in its chat, which asks for the name and the job. The owner answers there, and the bot sets them with `update_profile`. The bot's `bot_create` tool makes a bot from a name, a title and first instructions. The instructions are written to the new bot's CLAUDE.md as its first memory, under a header that names the bot that made it. They are not a rule, since a bot wrote them and a rule would be an owner permission. The tool is in the always-ask list, so the owner approves a card with the name, the title and the whole instructions before anything is made. The card refuses hidden characters, and a name or title that is not one short line. Every bot uses the same Claude sign-in and the same key proxy. Nothing of the key is copied into a bot.

The owner deletes a bot from its chat. The header "Delete" button shows a bar with Delete and Cancel. No browser dialog is used. Deleting a bot is `DELETE /api/bots/:id`. The server refuses the last bot, counting only bots that are not being deleted, and a bot whose Claude setup is not finished yet. A second delete of a bot already being deleted gets 409 at once and changes nothing. Otherwise the server first marks the bot as deleting in memory. From then on, a message, an upload, a queued turn or a webhook call to that bot gets 409 with "This bot is being deleted." Routine and watch turns skip it and log the refusal. Next the server stops the running turn and drops the queue. It waits up to 30 seconds for the turn to end, and then it answers 409 and nothing is removed. Then it removes the bot's app servers whose token it saved, its vault secrets, its GitHub listener, and its folders. The folders are the workspace, the uploads and the shared files. A folder is removed only when its real path is inside the root. A link at that path is removed and never followed. The bot row goes last, and every table with rows of the bot cascades from it, so its chats, rules, routines, watches, webhooks, integrations and turn state go with it. If a folder cannot be removed, the request fails and the bot stays, so the owner can try again. Shared connected apps that have no token stay, because they belong to no bot.

In agent-user mode the workspace belongs to the agent user, so the server cannot delete inside it. The server runs `/usr/local/bin/cloudbot-remove-workspace` through `sudo -n` as the bot user. The sudoers line allows only that script. The script checks that the id is one plain folder name, and it removes only under `/var/lib/cloudbot-workspaces`. The script first stops this user's processes that run inside the workspace, best effort, and then removes the bot's Claude Code folder under `~/.claude/projects`. The uploads and shared files are owned by the server, so the server removes them itself. In local mode the server removes the bot's transcripts from CloudBot's own Claude config folder under the data dir, and never touches the owner's `~/.claude`.

## Bot mascot

Each bot has a mascot: a cloud body in one of nine colors and one of four shapes, drawn
in SVG by `src/web/components/CloudMascot.tsx`, with a white face. The color and shape are
columns of `bots` (`mascot_color`, `mascot_shape`, migration 0011), chosen at random by
`BotStore.create` and changed by the `profile_set_mascot` tool. `src/shared/mascot.ts` holds the palette.

The face comes from `deriveMascotState` (`src/web/mascotState.ts`), from what the app already
knows, in this order: a pending approval card (waiting), a running turn (thinking), composer text
(typing), a turn that just ended (done, for two seconds), a usage limit note (sleepy), and a known
error note (error). The error note is matched by its exact text: a limit stop, the stall stop, and
the two fixed turn errors. Any other note leaves the face idle. A turn the owner stopped gets no
done face. The web app has no event for a usage wait or a routine wait, so the usage limit note is
matched by its text. Only the selected bot shows the live face. The others show idle. In a run of bot
messages, only the last one shows the mascot (`src/web/messageMascot.ts`). The bubbles above keep its
space, so the text lines up. The eyes of the idle and typing faces follow the pointer on every mascot, through
one shared window listener (`src/web/mascotPointer.ts`), batched per animation frame. While the owner types,
the eyes turn along the text box with the caret. The caret at the left edge turns them fully left, at the right
edge fully right, and linearly in between. They look down at the box by 6 units. The eyes move up to 9 units of the
160 unit wide view, which keeps them inside the face of every body. The whole cloud leans and shifts a little toward
the same look, so it reads on a 28 pixel mascot. A hidden mirror of the text box,
with the same styles and the text before the caret, gives the caret's place, so wrapped lines work. A shared
document listener on `input` and `selectionchange` (`subscribeToTyping`) measures at once on each change, not in
an animation frame, so a stalled frame cannot freeze the eyes. The last message mascot follows the caret too,
and takes the typing face while the owner types. The mascots blink after a random pause of 2.5 to 6 seconds, and no timer runs
while the tab is hidden. A mascot that is off screen, seen through an `IntersectionObserver`, does not follow the
pointer and does not blink, so a long chat costs nothing for them. Under `prefers-reduced-motion` the eyes, the lean
and the blink still run, with no easing, so they jump. The stylesheet stops the bounce, the squish and the hover motion there.

While a reply streams, the app joins the text deltas of one animation frame into one draft update, and the stored
messages are memoized (`MessageItem`), so a delta renders only the draft. Live messages that are not a stored reply
get the `is-entering` class and rise in. A stored reply takes the place of its draft, which already rose. Panels,
the streamed reply and the phone bot list move with transform and opacity only, and reduced motion turns that off.
The server sends `Cache-Control: public, max-age=31536000, immutable` for the hashed files under `/assets/` and
`no-cache` for every other web app file.

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

The server runs the `claude` CLI installed by Anthropic's installer
(`CLAUDE_PATH`). Sign-in, status and the agent all use that one
CLI. See [provider terms](PROVIDER_TERMS.md).

The bot profile reaches the agent in two ways. `buildSystemPrompt` turns the
name, title and description into a prompt that is appended to Claude Code's
default prompt, so the bot keeps its tool and coding instructions. The prompt
also says the bot runs
on the owner's VPS through CloudBot, and that its memory is `CLAUDE.md` in its
workspace. `createProfileTools` builds the bot's own tools, starting with
`update_profile`, which saves changes through `BotStore`. The tool is
bound to one bot id, and it is allowed up front so headless turns never ask.
The tool trims its fields and caps them at 40, 80 and 500 characters. It writes
only the fields the model passed, so a reply cannot overwrite the others. The
profile text is framed as the owner's words, with newlines collapsed, so it
cannot add instructions as new paragraphs. The tools are served for each turn under the
name `cloudbot`, so the CLI names the tool `mcp__cloudbot__update_profile`, which
`allowedTools` lists. The CLI does not load `CLAUDE.md` for a turn, so the server
reads the workspace file and appends it to the system prompt as memory notes.

`startClaudeLogin` runs login in a util-linux `script` pseudo terminal on Linux.
It exposes `signInUrl`, `submitCode`, `cancel` and `finished` for the
setup conversation. `signInUrl` resolves to null if login ends before a link
arrives. Failures name timeout, missing CLI, unsuccessful exit or cancellation.
Sessions time out after five minutes by default.

After a successful exit, the caller must use `getClaudeAuthStatus` to confirm
sign-in. It returns only login state and the authentication method. These
helpers do not read credential files or persist terminal output or codes.
The setup conversation calls these helpers and exposes only fixed status messages.
