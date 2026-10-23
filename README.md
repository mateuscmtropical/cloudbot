<h1><img src="docs/mascot.svg" alt="" width="40"> CloudBot</h1>

Your own always-on AI coworker, running on your VPS on the AI subscription or API key you choose.

You chat with it. It works on its own computer while you are away, and it
comes back when the job is done or when it needs you.

> **Early development.** CloudBot is not usable yet. The [roadmap](docs/ROADMAP.md)
> shows what comes first. Issues and pull requests are welcome.

> **Not an Anthropic product.** CloudBot is an independent open source project.
> It is not made, endorsed or supported by Anthropic or any other AI provider.
> It runs each provider's official CLI, with your own subscription or your own
> API key.

> [!WARNING]
> **Your use, your responsibility.** CloudBot can use websites, apps and
> accounts for you. Many platforms forbid or limit automated use in their terms.
> Using CloudBot on them can break those terms and lead to limits, a suspended
> or banned account, or other action by the platform. You are responsible for
> how you use CloudBot and for following the terms of every service it uses.
> CloudBot is provided "as is", without warranty of any kind, as stated in the
> [MIT license](LICENSE). Its authors and contributors are not responsible for
> how anyone uses it or for any loss, ban or claim that comes from that use.

## Install

On a Debian or Ubuntu server with a public IP, on x86-64 or ARM, one command
installs Docker, starts CloudBot behind HTTPS and prints the owner's address
and first password:

```sh
curl -fsSL https://raw.githubusercontent.com/mateuscmtropical/cloudbot/main/docker/install.sh | sudo bash
```

Without a domain it uses a free `<ip>.sslip.io` name. To use your own domain
and the owner's name, add them:

```sh
curl -fsSL https://raw.githubusercontent.com/mateuscmtropical/cloudbot/main/docker/install.sh | sudo bash -s -- bot.example.com maria
```

On Windows, on x64 or ARM, open PowerShell as administrator and run one command.
It installs WSL 2 with Ubuntu when it is missing, then runs the installer. If
Windows asks for a restart, run the command again afterwards.

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/mateuscmtropical/cloudbot/main/docker/install.ps1))) -OwnerName maria
```

CloudBot then opens at `http://maria.localhost` in your Windows browser.

The [install guide](docs/INSTALL.md) covers domains, adding people, updates and
the `cloudbot` command.
## What it will do

- **Chat like a messenger.** A list of bots on the left, the conversation in
  the middle.
- **Set itself up in the chat.** The first conversation asks which AI provider
  you want, signs you in and tells you when it is ready.
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
- **Run routines.** Scheduled tasks, tasks that run once at a set time, and tasks started by events.
- **Morning brief and quiet check-ins.** Ask in the chat for a daily brief of what matters, or for a check-in every few hours on your apps and accounts. A check-in messages you only when something needs you, and a run that finds nothing leaves no trace in the chat. Check-ins run on a small model unless you pick one for routines, and they follow the routines limits.
- **Wake it from outside.** Webhooks: a URL that another service calls to send the bot a message. A call with a delivery id is not queued twice within 24 hours, and the refused calls are listed for the owner.
- **Give a bot its own mailbox.** Tell it the provider's IMAP and SMTP settings in chat, approve the settings, then enter the password through the secure form. New mail arrives as an outside-data task. Each send waits for approval of the full recipient list, subject and text. Attachments are not supported.
- **Send instructions from WhatsApp.** Connect the official Meta WhatsApp Business Cloud API in the chat. Only your number is accepted. Replies stay in the web app. Existing push notices arrive when notifications are enabled. CloudBot never sends WhatsApp messages. See the [WhatsApp setup guide](docs/WHATSAPP.md).
- **Set limits.** Optional time, spending and step limits per turn, one set for chat and one for routines. A stopped turn says which limit it hit. The agent and the review agent are each held to the spending limit, so a turn can spend up to twice the limit. The spending is an estimate, and a subscription is not billed by it.
- **API integrations.** The bot writes a script that calls an outside API and runs it with your key from the vault. The key does not reach the model or the logs, and a changed script waits for your approval.
- **Connect apps.** The bot adds a remote MCP server by its address when you ask in the chat. A token goes through the secure form and stays in the vault. The Connect apps panel lists the servers and removes one.
- **Tell you when it is done.** Install the web app on your phone and ask a bot in the chat to turn on notifications. It posts a card with a button, and your browser asks for permission when you tap it. You get a notification when a turn finishes, when an approval waits and when the bot needs your screen. It shows the bot's name and a short line, never the text of a message. On an iPhone, add CloudBot to the home screen first. Notifications need HTTPS or localhost.
- **Sign in with a passkey.** Ask a bot in the chat to add a passkey and tap the card. That phone or computer then signs in with its lock screen, face or fingerprint. Ask the bot to list or remove them. The setup link from the server always works too. Passkeys need `CLOUDBOT_PUBLIC_URL` set to the name you open CloudBot at.
- **Talk from Telegram.** Make a Telegram bot with @BotFather and ask your bot in the chat to connect Telegram. It asks for the token through the secure form, then posts a one-time code in the chat. Send `/start` and the code to your Telegram bot. From then on only your Telegram account can talk to the bot there, and it answers there. Text only for now. Approvals still happen in the web app, and Telegram tells you when one waits.
- **Make more bots.** The + button adds a bot, and a bot can make one when you ask. Deleting a bot from its chat removes all of its data.
- **Teach it skills.** Ask a bot to learn a skill, or give it a link to one. It writes the steps as a skill, and you approve the whole text on a card before it is saved. The bot reads a skill when a task needs it. Ask it to list or remove its skills.
- **Teach it by showing.** Ask a bot to learn a task from you. It hands you its screen and records the browser while you do the task once. What you type into a password or another secret field is never recorded. Then it writes the steps as a skill, and you approve or fix them on the card.
- **Copy a bot.** Ask a bot to export itself and you get a template file in the chat. Attach that file and ask for a new bot from it. You see the whole template before the bot is made. Secrets, sign-ins, webhook addresses, shared files and learned memory are never in the file. Its routines start turned off.
- **Import a bot.** Paste instructions from another platform or attach a `.txt`, `.md` or JSON export. CloudBot prepares a name, description and instruction draft for you to approve in the chat. The instructions become memory text only. Platform actions, tools, skills, files, credentials, approval settings and routines are not imported. Recognizable credential values in the draft are redacted.
- **Share templates.** The template gallery lists public bot templates from a GitHub repository. Ask a bot to list them, to install one by its file name, or to share your bot there once GitHub is connected. The share opens a pull request from your fork of the gallery. You approve each card first. Set `CLOUDBOT_GALLERY_REPO` to read another repository.
- **Work as a team.** Several bots that pass work to each other, group chats
  and a manager bot.

The full plan, version by version, is in the [roadmap](docs/ROADMAP.md).

## AI providers

CloudBot never talks to a model on its own. Each turn runs in the provider's
official CLI, installed from the provider's own package or installer and never
modified. Every tool call the CLI asks for goes through the same review as
with Claude.

| Provider | CLI | Subscription | API key |
| --- | --- | --- | --- |
| Claude | Claude Code | Claude account, code pasted back | Anthropic |
| ChatGPT | Codex | ChatGPT account, device code | OpenAI |
| Gemini | Antigravity CLI for a subscription, Gemini CLI for a key | Google account, code pasted back | Google AI Studio |
| GitHub Copilot | Copilot CLI | GitHub account, device code | none |
| Cursor | Cursor CLI | Cursor account, link | none |
| Grok | Grok Build | xAI account, device code | xAI, run on opencode |
| Mistral | Mistral Vibe | Mistral AI Studio account, link | Mistral AI Studio |
| Qwen | Qwen Code | none | Alibaba Cloud Model Studio |
| Kimi | Kimi Code | Kimi account, device code | Moonshot AI |
| opencode | opencode | free models, no sign-in | none |

- One connection serves every bot. Each bot runs on one provider, and you
  switch it by asking the bot. The next message starts a new conversation on
  the new provider.
- A subscription sign-in happens on the provider's own page. The CLI keeps the
  credentials in the agent user's home. CloudBot does not read, copy or store
  them.
- An API key stays in CloudBot's vault. The CLI gets a local key proxy address
  and a dummy key, so the bot cannot read the real key.
- The review of each call runs on Claude. Without Claude connected, every
  reviewed call asks you instead.
- "none" means the CLI has no sign-in or key that CloudBot can run safely. A
  Copilot or Cursor token cannot go through the key proxy, so it is not offered.
  Qwen Code no longer has a free account sign-in.
- A provider shows up in the setup list only when its CLI is installed. The
  Docker image installs all of them. A local run uses Claude and, with
  `CODEX_PATH`, ChatGPT. The others need `CLOUDBOT_<PROVIDER>_PATH`, such as
  `CLOUDBOT_GEMINI_PATH`, set to the absolute path of the CLI.

Read [provider terms](docs/PROVIDER_TERMS.md) before you use a subscription
with CloudBot.

## Voice input

In browsers with speech recognition, such as Chrome and Edge, the message box has a microphone button. Press it to speak, and the words go into the message box. Press it again to stop.

Chrome and Edge send the audio to their speech service to turn it into text. The app never receives the audio. The browser asks for microphone permission only when you press the button.

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

The link uses `CLOUDBOT_PUBLIC_URL` when it is set, and `http://127.0.0.1:PORT`
otherwise. The cookie is `Secure`, so open the link on localhost or over HTTPS.

A local run listens on `127.0.0.1` only. Set `HOST` to listen on another
address, and the Docker image sets `HOST=0.0.0.0`.

## Connect a provider in chat

After opening the owner link, the first bot asks which provider to connect.
This is a scripted conversation that works before any provider is connected.
Pick a provider, then pick Subscription or API key. A provider with only one
way skips the second question. On the web page, a sign-in opens in a new tab.

- **Claude subscription:** open the sign-in link, sign in on Anthropic's page
  and paste its code into the code field. CloudBot passes it to the official
  CLI and checks sign-in status. The code is never stored or logged.
- **Other subscriptions:** CloudBot starts the CLI's own login and posts its
  link, with the device code when the CLI shows one. For Gemini, Google's page
  shows a code that you paste back. If Google refuses the code, the chat says
so and shows the providers again. The sign-in is checked when the CLI ends.
- **API key:** paste the key into the secure form. CloudBot sends one cheap
  request to the provider to check it, then stores it only in the encrypted
  vault. The Anthropic key is saved without that check. Turns use the key
  through a local key proxy, and the agent receives a dummy key.

Setup remembers your mode and step across restarts. An interrupted subscription
login gets a fresh link and code field because the old login process has ended.
Failures offer another choice. Normal chat starts once setup says the provider
is ready. Ask a bot to connect another provider and the list comes back in the
setup chat.

## Run with Docker

The image runs the server as the `cloudbot` user and runs the provider CLIs as
the `bot` user. The CLIs are owned by root, so the `bot` user cannot replace
them. The data folder is a Docker volume that only
`cloudbot` can read.

The bot home and workspaces also use named volumes to preserve provider sign-ins,
sessions and memory. The install above starts a hub, a Docker socket proxy and
Caddy, and the hub starts one container for each person. See the
[install guide](docs/INSTALL.md) for volumes, updates and CLI update behavior,
and [multi-user design](docs/MULTI_USER.md) for how the pieces fit.
## Security

The [threat model](docs/THREAT_MODEL.md) says what the bot can reach, what stops
it and where the protections end. To report a vulnerability, read the
[security policy](SECURITY.md). Do not open a public issue for it.

## License

[MIT](LICENSE)
