# Install CloudBot on a server

This guide installs CloudBot on one server with a public IP address. It takes
one command, and the first build takes a few minutes.

## What you need

- A fresh Debian (12 or newer) or Ubuntu (22.04 or newer) server, with root or
  sudo access.
- A public IP address. The installer uses it for the free HTTPS name.
- Ports 80 and 443 open to the internet. Caddy needs port 80 to get the
  certificate, and port 443 serves the site.
- Your own domain (optional). Its DNS record must point to the server before
  you install.

## Install

Run this on the server:

```sh
curl -fsSL https://raw.githubusercontent.com/mateuscmtropical/cloudbot/main/docker/install.sh | sudo bash
```

The script:

1. Checks that the system is Debian or Ubuntu and that it runs as root.
2. Installs git and curl.
3. Installs Docker with Docker's official convenience script, only when Docker is missing.
4. Clones CloudBot into `/opt/cloudbot`, or pulls the latest code if it is there.
5. Picks the domain. With no argument it uses `<public-ip-with-dashes>.sslip.io`,
   for example `203-0-113-5.sslip.io`.
6. Writes `/opt/cloudbot/.env` with `CLOUDBOT_DOMAIN`.
7. Runs `docker compose up -d --build`, then waits for the health check.
8. Prints the setup link. Open it in your browser to become the owner.
9. Installs the `cloudbot` command at `/usr/local/bin/cloudbot`.

Open the setup link within a few minutes of the install. If you miss it, print a
new one (see below).

## Setup link

The first person who opens the setup link becomes the owner. The link works once.

To print a new link, for example if you lost the first one:

```sh
sudo cloudbot setup-link
```

A new link ends every existing session, so only use it when you need to.

## Your own domain

Point a DNS `A` record for your domain to the server IP, then install with the
domain as an argument:

```sh
curl -fsSL https://raw.githubusercontent.com/mateuscmtropical/cloudbot/main/docker/install.sh | sudo bash -s -- bot.example.com
```

To change the domain later, run the same command again with the new domain.

## Update

```sh
sudo cloudbot update
```

This pulls the latest code with `git pull --ff-only` and rebuilds the containers.
Four volumes keep your data across updates:

| Volume | Holds |
|---|---|
| `cloudbot-data` | The database and the vault |
| `cloudbot-home` | The bot home: the Claude login, sessions and the Claude Code CLI |
| `cloudbot-workspaces` | Each bot's workspace, with its memory in `CLAUDE.md` |
| `cloudbot-uploads` | Files attached in chat. The bot can read them but cannot change them |

The CLI in `cloudbot-home` updates itself, so a new image does not replace it.
`docker compose down -v` deletes all four volumes, including the Claude login.

## Commands

| Command | What it does |
|---|---|
| `sudo cloudbot status` | Shows the containers and their health |
| `sudo cloudbot logs` | Follows the logs. Press Ctrl+C to stop. |
| `sudo cloudbot update` | Pulls the latest code and rebuilds |
| `sudo cloudbot setup-link` | Prints a new setup link. It ends every existing session. |

## Troubleshooting

- The browser says the certificate is not valid: check that the DNS record
  points to the server and that ports 80 and 443 are open. Caddy retries on its own.
- The install stops at the health check: run `sudo cloudbot logs` and look for errors.
- The setup link was not printed: the owner is already set. Run `sudo cloudbot setup-link`.