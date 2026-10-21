<h1><img src="docs/mascot.svg" alt="" width="48" align="middle"> CloudBot</h1>

Your own always-on AI coworker, running on your VPS and powered by Claude.

You chat with it. It works on its own computer while you are away, and it
comes back when the job is done or when it needs you.

> **Early development.** CloudBot is not usable yet. The [roadmap](docs/ROADMAP.md)
> shows what comes first. Issues and pull requests are welcome.

> **Not an Anthropic product.** CloudBot is an independent open source project.
> It is not made, endorsed or supported by Anthropic. It runs the official
> Claude Code CLI and the official Claude Agent SDK, with your own Claude
> subscription or your own API key.

> [!WARNING]
> **Your use, your responsibility.** CloudBot can use websites, apps and
> accounts for you. Many platforms forbid or limit automated use in their terms.
> Using CloudBot on them can break those terms and lead to limits, a suspended
> or banned account, or other action by the platform. You are responsible for
> how you use CloudBot and for following the terms of every service it uses.
> CloudBot is provided "as is", without warranty of any kind, as stated in the
> [MIT license](LICENSE). Its authors and contributors are not responsible for
> how anyone uses it or for any loss, ban or claim that comes from that use.

## What it will do

- **Chat like a messenger.** A list of bots on the left, the conversation in
  the middle.
- **Set itself up in the chat.** The first conversation asks how you want to
  connect Claude, signs you in and tells you when it is ready.
- **Work on its own computer.** A browser, a terminal and files of its own.
  It shows you screenshots as it works. Its browser cannot reach private or
  local addresses unless you allow a host.
- **Hand the screen to you.** When a site asks for something only a person can
  do, such as a CAPTCHA or a 2FA code, it opens the screen for you and takes
  over again when you say so.
- **Keep secrets away from the bot.** Passwords and keys go through a secure
  form into a vault. The bot uses them without being able to read them.
- **Ask before it acts.** Rules written in plain language, and a review step
  before sensitive actions such as sending a message or paying.
- **Run routines.** Scheduled tasks and tasks started by events.
- **Wake it from outside.** Webhooks: a URL that another service calls to send the bot a message. A call with a delivery id is not queued twice within 24 hours, and the refused calls are listed for the owner.
- **Set limits.** Optional time, spending and step limits per turn, one set for chat and one for routines. A stopped turn says which limit it hit. The agent and the review agent are each held to the spending limit, so a turn can spend up to twice the limit. The spending is an estimate, and a subscription is not billed by it.
- **Connect apps.** Claude connectors, remote MCP servers and APIs you give it
  a key for.
- **Work as a team.** Several bots that pass work to each other, group chats
  and a manager bot.

The full plan, version by version, is in the [roadmap](docs/ROADMAP.md).

## How it connects to Claude

CloudBot never talks to Claude on its own. It runs Anthropic's tools:

- The [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
  drives the agent.
- The SDK runs the Claude Code CLI (`claude`), installed from Anthropic's
  official installer and never modified.
- With a subscription, you sign in through Anthropic's own page. The CLI keeps
  the credentials. CloudBot does not read, copy or store them.
- With an API key, the key stays in CloudBot's vault and the bot cannot read
  it.

Read [provider terms](docs/PROVIDER_TERMS.md) before you use a subscription
with CloudBot.

## Development

You need Node 24 or newer and pnpm 10.

```sh
pnpm install
pnpm dev
```

`pnpm check` runs lint, typecheck, tests and build. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## Owner access

When the server starts with no owner, it prints a setup link. Open it in the
browser you want as the owner. The link works once and sets a session cookie.

If you lose the cookie, run `pnpm build` and then `pnpm setup-link`. It prints
a new link and ends every existing session.

The link uses `CLOUDBOT_PUBLIC_URL` when it is set, and `http://localhost:PORT`
otherwise. The cookie is `Secure`, so open the link on localhost or over HTTPS.

## Connect Claude in chat

After opening the owner link, the first bot asks how to connect Claude. This
is a scripted conversation that works before Claude is connected.

- **Subscription:** open the sign-in link, sign in on Anthropic's page and
  paste its code into the code field. CloudBot passes it to the official CLI
  and checks sign-in status. The code is never stored or logged.
- **API key:** paste your Anthropic key into the secure form. It is stored
  only in the encrypted vault. Saving the key completes setup without an API
  validation request. The first chat turn uses it through a local key proxy.
  The agent receives the proxy address and a dummy key.

Setup remembers your mode and step across restarts. An interrupted subscription
login gets a fresh link and code field because the old login process has ended.
Failures offer another choice. Normal chat starts once setup says Claude is ready.

## Install on a server

On a fresh Debian or Ubuntu server with a public IP, one command installs Docker,
starts CloudBot behind HTTPS and prints the setup link:

```sh
curl -fsSL https://raw.githubusercontent.com/mateuscmtropical/cloudbot/main/docker/install.sh | sudo bash
```

See [install guide](docs/INSTALL.md) for your own domain, updates and the `cloudbot` command.

## Run with Docker

The image runs the server as the `cloudbot` user and installs the Claude Code
CLI as the `bot` user. The data folder is a Docker volume that only
`cloudbot` can read.

The bot home and workspaces also use named volumes to preserve Claude login,
sessions and memory. See [installation and updates](docs/INSTALL.md) for volume
and CLI update behavior.

To run it locally behind Caddy on `https://localhost`:

```sh
docker compose -f docker/compose.yaml up --build
```

On a VPS, point a domain at the server and set it before you start:

```sh
CLOUDBOT_DOMAIN=bot.example.com docker compose -f docker/compose.yaml up -d --build
```

Caddy gets the HTTPS certificate for that domain. Ports 80 and 443 must be open.

The setup link is in the logs (`docker compose -f docker/compose.yaml logs cloudbot`).
To print a new one, run
`docker compose -f docker/compose.yaml exec cloudbot node dist/server/newSetupLink.js`.

## License

[MIT](LICENSE)
