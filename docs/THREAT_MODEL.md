# Threat model

This page says what CloudBot defends, against whom, and where the defense
stops. It describes the CLI engine, which runs the official `claude` CLI in
headless mode for every turn.

[ARCHITECTURE.md](ARCHITECTURE.md) explains how each part works. This page
links to it instead of repeating it. To report a problem, read the
[security policy](../SECURITY.md).

## Who is trusted

| Who or what | Trust |
|---|---|
| The owner, holding the session cookie | Trusted |
| The CloudBot server code | Trusted |
| The bot, which is a model plus everything it runs | Not trusted. It can be misled. |
| Text from outside: web pages, files, webhook bodies, page watches, email, replies from connected apps, messages from other bots | Not trusted. It is data, never instructions. |
| A WhatsApp message from the owner's number, after the signature and the number are checked | Trusted as the owner |
| A WhatsApp message from any other number | Dropped silently |
| A stranger on the internet | Reaches only the public routes |

The main threat is prompt injection. Text that the bot reads can talk it into
acting against the owner. CloudBot assumes this will sometimes work. So the
protections sit outside the model: separate Unix users, the vault, proxies, an
address gate, a command floor and owner approvals.

The public routes are `/api/health`, `/setup` (needs the one-time code),
`/hooks/<token>` (needs the webhook token), `/whatsapp` (needs Meta's signature
or the verify token), `/api/apps/oauth/callback` (needs the one-time state of a sign-in the owner started, see
[Connected apps](ARCHITECTURE.md#connected-apps)) and the static web app files. Every other `/api` route
needs the session cookie.

## Layers at a glance

| Layer | What it stops | What it does not stop |
|---|---|---|
| Separate Unix users | The bot reading the vault, the database and the shared file copies | The bot using its own home, the workspaces, the browser profile and the network |
| Vault and proxies | The bot reading the API key, the GitHub token, app tokens and the secrets it asked for | The bot using those proxies |
| Address gate | The browser, page watches and connected apps reaching private addresses | The bot's shell and the CLI's own WebFetch tool |
| Owner rules | Tools the owner named in a block rule | Intent that no tool name captures |
| Command floor | A fixed list of destructive commands and reads of the vault files | Commands built at run time |
| Review agent | Calls a model judges unsafe. Sends, purchases and bookings always ask. | A model that is fooled |
| Owner approval | Any call that waits for the owner | An owner who approves without reading |
| Turn limits | Runaway time, steps and spending | Anything, while the limits are unset. That is the default. |

## What the bot can reach

### Docker mode

Docker is the supported way to run CloudBot. See
[Docker](ARCHITECTURE.md#docker) for the details.

The server runs as the `cloudbot` user. The bot runs as the `bot` user. Each
turn the server starts the `claude` CLI through `sudo -n -u bot`, with only a
few environment variables. The data folder `/var/lib/cloudbot` is mode 700 and
belongs to `cloudbot`. The CI check `docker/check-container.sh` proves that
`bot` cannot read a file the server user wrote there.

The bot can:

- Run commands and edit files as `bot`.
- Read and write `/home/bot`. That holds the Claude login of a subscription,
  the CLI sessions and the Chromium profile with every site the bot or the
  owner signed in to.
- Read and write the workspaces of all bots. They share one Unix account, so
  workspaces do not isolate bots from each other.
- Read the upload folders. It cannot change them.
- Open any outbound network connection. Nothing filters the shell's traffic.
- Reach the services that listen on loopback inside the container. They have no
  login of their own. The server's own port needs the session cookie.
- Use the tools that CloudBot gives it. Each one is listed in
  [ARCHITECTURE.md](ARCHITECTURE.md).

The bot cannot:

- Read the vault, the database or the shared file copies in the data folder.
- Become root or another user. The sudoers file names the server user only.
- Reach the host. The container is not privileged, mounts no Docker socket and
  mounts only its own named volumes. Compose publishes ports 80 and 443 of
  Caddy and exposes the server port only to the Caddy container.
- Read the server's environment. The agent gets `HOME`, a fixed `PATH`, the
  addresses of its proxies and dummy keys.

### Local mode

Without `CLOUDBOT_AGENT_USER` the bot runs as your own account on your own
computer. CloudBot prints a warning at start. A server with `NODE_ENV` set to
`production` refuses to start without an agent user, and the Docker image sets
both. Local mode is for development.

- The bot can read and change anything your account can.
- The bot gets your environment, minus every `ANTHROPIC_` variable and
  `CLAUDE_CODE_OAUTH_TOKEN`. Other tokens in your environment reach it.
- The vault files are in the data folder, which your account can read. The vault
  keeps nothing from the bot here. Only the floor, which refuses commands that
  name `vault.key` or `vault.json`, stands in the way.
- The floor protects the Docker data folders by their fixed paths. It does not
  guard your own data folder against a delete.
- CloudBot's Claude login lives in `<data dir>/claude-config`, so it never
  replaces the login of your own Claude Code.
- The browser tools use an installed Chrome, Chromium or Edge with its own
  profile in the data folder. It goes through the same gate as in Docker. See
  [Local browser](ARCHITECTURE.md#local-browser).

Setting `CLOUDBOT_AGENT_USER` outside Docker gives the user separation without
the container. Then the local browser stays off, because Chrome would run as
the server user.

## What the vault and the proxies keep from the bot

| Secret | Where it lives | How the bot uses it | What the bot never gets |
|---|---|---|---|
| API key of an AI provider | The vault | Through a key proxy per provider | The key. It gets the proxy address and a dummy key. |
| GitHub token | The vault, per bot | Through `GithubProxy` for `git` and `gh` | The token. A token saved for another site is never sent. |
| Token of a connected app | The vault, per bot. A sign-in on the app's own page keeps the access and refresh tokens here too | Through `AppProxy`, which renews an old access token | The token and the server address |
| Google Cloud client of the owner | The vault, per bot, as `OAUTH_GOOGLE_CLIENT` | Used by `AppOAuth` for the Google sign-in | The client secret. `browser_type_secret` refuses `OAUTH_` names, and the panel never shows it again |
| Integration secret | The vault, per bot | Through a script that runs as `cloudbot-integrations` | The value. It is removed from the output. |
| Bot mailbox password | The vault, per bot | Used by the IMAP reader and SMTP sender over TLS | The value, in the model, chat, database or logs |
| Bitwarden account of the owner (server, API key and master password) | The vault, per bot, as `BITWARDEN_ACCOUNT`, and the session key in the memory of the server | Used by `BitwardenCli`, which only the server process runs | The account and the session. `BITWARDEN_` and `OAUTH_` names are refused by `browser_type_secret`, `app_connect`, integrations and `request_secret`. The panel never shows them again |
| A login of the owner's Bitwarden vault | Bitwarden. The server reads one value at a time | `browser_fill_login` types it after the owner approves | The value, in the chat, in a tool result or in a log. The list for the model holds names only |
| Password, code or card the bot asked for | The vault, per bot and per site | `browser_type_secret` types it | The value, in the chat, in a tool result or in a log |

How each one works is in [Secrets](ARCHITECTURE.md#secrets),
[GitHub](ARCHITECTURE.md#github), [Connected apps](ARCHITECTURE.md#connected-apps)
and [API integrations](ARCHITECTURE.md#api-integrations).

The vault encrypts each value with AES-256-GCM and a new random IV. The key is
32 random bytes in `vault.key`, next to `vault.json`. Both files are mode 600.
The encryption alone helps only when someone gets `vault.json` without
`vault.key`. The real protection is the Unix permission on the data folder.

Each key proxy sends the bot's requests to its one provider's API and adds that
provider's key. It sends nothing to any other address.

A secret that the bot asked for with `request_secret` is saved with an https
site. `browser_type_secret` types it only when the page origin is that site and
the focused element is a password, one-time code or card field. A search box or
a text field is refused. Names that start with `ANTHROPIC_` or `CLAUDE_` are
refused, so a bot form cannot pass for the setup form.

The master password of a Bitwarden account sits in the vault next to the other
secrets, so anyone who gets `vault.json` and `vault.key` gets it, and with the API key
that opens the whole Bitwarden vault. The owner should connect a separate Bitwarden
account, or an organization collection, that holds only the logins the bot may use. The
state folder of `bw` is under the data folder, mode 700, so the bot user cannot read it.
No secret goes in a command line, only in the environment of the `bw` child process.

A prompt injection can tell the bot to fill a login on another site, for example a look-alike
page. `browser_fill_login` does not trust the model for the site. The server reads the real origin
of the open page and offers only the logins whose address matches that origin, on https. Host
look-alikes such as `github.com.evil.com` do not match. Then the owner reads the login and the site in the
chat and approves. The approval lasts ten minutes for that login and that site only. A page the bot
reached through a redirect is judged by where it really is. Accepted limit. A login whose address is
a shared suffix such as `github.io` matches every page under it, so the owner should keep such
addresses out of the collection that the bot may use.

Accepted limit, shared with `browser_type_secret`. Once a value is typed, it sits in the field of
the page. Chromium runs as `bot` and listens for DevTools on `127.0.0.1:9222`, so a shell command
of the bot could read the field through that port. Such a command still goes through the tool call
review, and the owner approved the login and the site first. The fill keeps the value out of the
chat, the tool results and the logs. It does not hide it from a bot that sets out to read the page.

The subscription login is not in the vault. Each provider's CLI keeps it in the
home of the `bot` user. CloudBot never reads, copies or stores it. The bot
runs as the same user, so in Docker its shell can read those files. A tool call
that names a CLI's sign-in or config folder is refused before the review, but
this is a text match, and a path built at run time is not caught.

## What stops the bot from doing harm

The turn settings mark every built-in and every MCP tool as an ask, so the CLI
sends each call to the loopback permission tool before it runs. See
[Tool call approval](ARCHITECTURE.md#tool-call-approval). A failure of that tool
or of the review refuses the call. It never lets it through.

### Owner rules

The owner writes rules in plain language. Each sentence goes into the system
prompt. A block rule can also name tools, such as `Bash(rm:*)`. Those go to the
CLI as `--disallowedTools`, and each helper agent gets them as
`disallowedTools`. Only the owner can change rules through the web app. The bot
can propose a change with a tool, and the owner approves it. A rule that names
no tool is advice to the model and not a barrier. A misspelled tool name blocks
nothing. See [Owner rules](ARCHITECTURE.md#owner-rules).

CloudBot also always disallows the CLI built-ins that operate separate CLI
services. The list covers `CronCreate`, `CronDelete`, `CronList`,
`ScheduleWakeup`, `RemoteTrigger`, `PushNotification`, `SendMessage`,
`ListAgents`, `Workflow`, `Monitor`, `EnterWorktree`, `ExitWorktree`,
`DesignSync`, `ReportFindings`, `TaskStop`, `NotebookEdit`, `PowerShell` and
`Skill`. The same fixed list reaches every main turn and helper agent. Owner
blocks are added to it. CloudBot's own shell, file, web, helper and MCP tools
stay available under their existing review rules. CLI skills are not loaded by
CloudBot.

### Command floor

Before any rule, approval or model, a fixed floor refuses a short list of
commands. It cannot be lifted by a rule, an approval or a model choice. It
refuses:

- A recursive delete of the disk root, the homes or the CloudBot data folders.
- A format of a disk, or a write to a disk device.
- A fork bomb.
- Stopping, disabling or editing the CloudBot service or container.
- Any write into `/etc/systemd/system`.
- Any read, copy or search of the vault files.

The floor is a floor and not a shell parser. See
[Command floor](ARCHITECTURE.md#command-floor) for the full list and for what it
does not see.

### Review agent

After the floor, `classifyToolCall` sorts the call:

- Reading tools, tools that only change the bot's own profile or ask the owner
  for something, and handing work to a helper run without a review. Each helper
  call is reviewed on its own.
- A connector tool whose name has a word like send, reply, purchase, buy, pay,
  checkout, book or order always asks the owner. So does a `Bash` command that
  mails or posts data out, and a call with an input over 10000 characters.
- A few CloudBot tools always ask the owner: allowing a private host, connecting
  an app, creating or deleting a bot, creating or changing an integration,
  changing a rule and changing a limit.
- Every other call goes to the review model.

The review model is one call with no tools, no settings files, no saved session
and one turn. It sees the call, the owner rules and the last six chat lines.
Webhook bodies, page watches and messages from other bots are labeled as not the
owner. It answers with a category and a decision. A purchase or a booking
always becomes a question for the owner. A message, a remote write or a system
change runs when the owner asked for it in their own chat message, and asks
otherwise. An answer that is not valid sends the question to the owner. When
Claude is not signed in, the review runs on Codex with the ChatGPT sign-in in a
read-only turn that never asks, and then on agy as the bot user, whose hook
refuses every tool. When no review model answers in 60 seconds, the call runs.
This is a deliberate trade: without any review model, prompt injection is
stopped only by the command floor, the always-ask tools and the sensitive data
check. See
[Review agent](ARCHITECTURE.md#review-agent).

### Owner approval

A question is a card in the chat with Approve and Deny. The call waits at most
one hour. Silence, Stop and a restart all count as Deny. A reviewer that fails
asks the owner and never lets the call run.

Some cards show the whole content, so the owner reads what will run:

- A script of an integration, in full, with its hash.
- The name, title and instructions of a new bot.
- The text of a hand-off to another bot.
- A rule or limit change, with old and new values.
- A write to GitHub, such as a push, with every ref or the whole request body.

These cards are refused, and not cut, when they are too long to show whole or
when they have hidden characters. So the text on the card is the text that runs.

### Turn limits

Each bot can have a time, spending and step limit per turn. They are off until
the owner sets them. A turn that sends no event for 10 minutes is always
stopped. See [Turn limits](ARCHITECTURE.md#turn-limits).

## The address gate

One check, `isPublicAddress`, refuses loopback, private, link-local, CGNAT,
multicast and reserved addresses. It also refuses the cloud metadata addresses
and the addresses of the server itself. An IPv6 address that carries an IPv4
address is checked as that IPv4 address. Each user of the check resolves the
name once, checks every address and connects to exactly the address it checked.

| Path | Guard |
|---|---|
| Browser | The SOCKS5 gate `BrowserGate`. Chromium has no other way out. The tools stay off until a self-check passes. |
| Page watches | `fetchWatchedPage`. Only http and https, at most 3 redirects, each hop checked again. |
| Connected apps | `checkAppUrl` when the app is added and `AppProxy` again on every request |
| GitHub | `GithubProxy` forwards only to GitHub |
| Integrations | No gate. The owner approves the script, and the run uses its own user. |
| Email | `email_setup` requires an owner card for the configured hosts. IMAP and SMTP require TLS with certificate checks. | No address gate or DNS pinning for the configured hosts |
| The bot's shell and the CLI's WebFetch tool | No gate |

The owner can allow one private host for the browser with `browser_allow_host`.
It always asks. Loopback, this machine, link-local and metadata addresses can
never be allowed. See [Network gate](ARCHITECTURE.md#network-gate) and
[Page watches](ARCHITECTURE.md#page-watches).

## Who can talk to CloudBot

### The owner

On start, a server with no session prints a setup link with a one-time code of
256 random bits. Opening it sets a session cookie (`HttpOnly`, `Secure`,
`SameSite=Strict`, one year) and the code stops working. Request origin checks
are pending ([#167](https://github.com/mateuscmtropical/cloudbot/issues/167)).
Only SHA-256 hashes of
the code and the token are stored, and they are compared in constant time.
There is one session at a time. A new link ends the old session. The first
person to open the link becomes the owner, so open it soon after the install.
See [Access](ARCHITECTURE.md#access).

The live screen sockets also need the cookie, and they refuse an `Origin` that
is not the server's own host or the host of `CLOUDBOT_PUBLIC_URL`. The Screen
panel is view only unless the owner holds the screen.

### Webhooks

The URL of a webhook is `<public address>/hooks/<token>`. The token is 32
random bytes, and only its SHA-256 hash is stored. The URL is shown once, only
in the web app. It never reaches the model, the chat history or the log. A call
is refused with 413 above 64 KB, and with 429 above 30 calls a minute for all
the webhooks of one bot, or when 10 webhook messages already wait. The body
reaches the bot marked as outside data, and the review reads it as not the
owner. There is no signature check, so the token is the only secret. See
[Webhooks](ARCHITECTURE.md#webhooks).

### Email

Incoming email is outside data. The chat message has a fixed marker, the review
context labels it `Email (outside data)`, and the system prompt tells the bot
not to follow instructions in mail. This is a prompt defense, so a model can
still be misled. Sending mail has an external gate: the owner approves a card
with every recipient, the subject and the full text. A card that cannot show
the complete mail is refused. Mailbox settings also require an owner card. The
password is entered through a secure form into the vault and is used only by
the server's IMAP and SMTP clients. Attachment contents are discarded and are
not exposed to the bot or sent. See [Email](ARCHITECTURE.md#email).

### WhatsApp

The callback URL is `<public address>/whatsapp`. It is public, like a webhook
URL, because Meta calls it. `GET /whatsapp` is Meta's verification handshake:
the verify token is compared in constant time with the token of any connected
bot, and only then is the challenge returned. `POST /whatsapp` carries
`X-Hub-Signature-256`, an HMAC SHA-256 of the exact raw body with the app secret
of the phone number in the call. CloudBot checks it, also in constant time,
before reading a message. A call that no connection could have signed gets 401.
The body is at most 1 MiB. Status callbacks and unconnected phone number IDs
change nothing.

Only the owner's number may send instructions. It is read from the vault and
compared with Meta's sender for every message. Any other sender is dropped
silently, with no turn, no note and no reply. A handled message id is stored for
8 days, so a Meta retry is answered without running the message twice. A text
message becomes an ordinary chat turn, with the chat model and limits. Other
message types get a system note in the chat saying that only text is supported.
CloudBot never sends a WhatsApp message, so the answer stays in the web app.
The existing push notification announces it when notifications are enabled.
The app secret, the verify token and the owner's
number are bot secrets in the vault. They never reach the model, the messages,
the database in plaintext or the log. See
[WhatsApp](ARCHITECTURE.md#whatsapp) and [WhatsApp setup](WHATSAPP.md).

### Other bots

A hand-off from another bot is a user message labeled as not the owner. The
receiving turn runs under its own rules, review and approvals, so a bot cannot
use another bot to skip a block. A chain is at most 4 bots long. See
[Bot hand-offs](ARCHITECTURE.md#bot-hand-offs).

### The web app

Markdown from the bot is rendered with raw HTML shown as text, images shown as
text, and only http, https and mailto links kept. Downloads of shared files use
`Content-Disposition: attachment` and `nosniff`, and unknown types are served as
`application/octet-stream`. See [Shared files](ARCHITECTURE.md#shared-files).

## Known limits

These are accepted today. A report about one of them is out of scope in the
[security policy](../SECURITY.md).

### The bot's environment

- The shell is not behind the address gate. It can reach whatever the container
  can reach, such as private networks and the provider's metadata address. The
  CLI's WebFetch tool is not behind the gate either. Both go through the review
  like other tools.
- All bots share one Unix account. They can read each other's workspaces, the
  upload folders, the Chromium profile and the environment of each other's
  shell. One bot can use another bot's GitHub access for reads. Only writes ask
  the owner.
- The Chromium profile holds the sessions of sites that were signed in. The bot
  can read it, and it can drive the browser.
- The subscription login of every provider is readable by the bot in Docker.
- Chromium runs with `--no-sandbox`, because Docker's default seccomp profile
  blocks the namespaces its sandbox needs. See
  [OWNER_QUESTIONS.md](OWNER_QUESTIONS.md).
- The bot can use an API key through its key proxy outside the turn limits. A
  command can reach every key proxy, not only the one of its own provider. The
  limits count the spending that the Claude CLI reports. Other providers have
  no spending limit yet.
- A provider CLI other than Claude decides which of its tools ask first. Its
  questions are reviewed, but a tool that the CLI runs without asking is not
  seen. Mistral Vibe and opencode are set to ask for every tool.
- The memory of a bot is `MEMORY.md` in its workspace, and the bot writes it.
  Text from a web page can end up there and come back in later turns.

### The checks

- The floor does not see commands built at run time, such as variables,
  `$(...)` or encoded text. It does not read a script piped into a shell. It
  also refuses some harmless commands. See
  [Command floor](ARCHITECTURE.md#command-floor).
- The review is a model reading text that the bot wrote. It can be wrong or
  misled. The always-ask rule for connectors is a name and pattern check and not
  a proof.
- A card for a call that the model reviewed shows one sentence. The model wrote
  it, and the owner does not see the raw input. The cards listed under
  [Owner approval](#owner-approval) show the whole content.
- An approved script of an integration can send its secret to any address it can
  reach. The runner has more limits, listed in
  [API integrations](ARCHITECTURE.md#api-integrations), and it has not been run
  end to end on a real host.
- The spending limit holds the agent and the review agent separately, so a turn
  can spend up to twice the limit. Secure input does not pause the time limit.
- These rest on the CLI documentation and were not checked against a live CLI:
  that the CLI enforces `disallowedTools` inside a helper agent, and that
  helper calls reach the approval route.

### Access

- Anyone who has a webhook URL can start bot turns, up to the rate limit. Treat
  the URL like a password and delete a webhook that leaked.
- A WhatsApp call needs the app secret that signed it. A leaked app secret lets
  its holder send signed calls, but only messages from the owner's number in the
  vault are handled. Other senders are dropped silently.
- There is no passkey or password. The session cookie is the only login, and it
  lasts a year unless a new setup link ends it.
- Security headers on the page are pending
  ([#167](https://github.com/mateuscmtropical/cloudbot/issues/167)).
- Request origin checks are pending
  ([#167](https://github.com/mateuscmtropical/cloudbot/issues/167)).
- Delivery ids of webhooks live in memory, so a restart forgets them and the
  same call can be queued again.

### The supply chain

- The image downloads the `claude` CLI with Anthropic's installer at build
  time. The CLI then runs from a root-owned copy and does not update itself.
  Updates come with a new image.
- The other provider CLIs come from npm or from each vendor's install script
  at build time, pinned to a version where the source allows it. They are owned
  by root, so the bot user cannot replace them, and update checks are off
  where the CLI has a switch for it.
- `docker/install.sh` runs with `curl | sudo bash`, and `cloudbot update` pulls
  `main` with `git pull --ff-only`. Nothing checks a signature.

## Changing this page

A change that touches a protection above updates this page in the same pull
request. A new known limit goes in the list.
