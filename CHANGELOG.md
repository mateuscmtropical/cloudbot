# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Claude subscription login helpers for the setup chat, with sign-in links,
  code submission, cancellation, timeout handling and CLI status checks.
- Project setup: server with a health route, lint, tests, CI and docs.
- Secrets vault with encryption at rest, a secure form endpoint and a local key proxy that adds the API key to requests.
- SQLite storage for bots, messages and settings with Drizzle ORM, with migrations that run on start. Migrations are found next to the install, not in the working directory.
- Agent runner that streams one conversation turn through the Claude Agent SDK.
- Bot profile: the bot can change its own name, title and description from the chat, and its system prompt says who it is and where its memory lives (`CLAUDE.md`).
- Docker image and compose file with Caddy in front for HTTPS. The server runs as `cloudbot` and the Claude Code CLI is installed for `bot`. The data volume is readable only by `cloudbot`. CI builds the image and checks the health route and the isolation of the data folder.
- Chat web interface in `src/web`: bot list, Markdown messages, setup messages and a composer. The server serves the build from `dist/web`.
- One-time setup link printed on start. Opening it sets a session cookie, and every `/api` route except health needs that cookie. A new code ends the old sessions.
- `pnpm setup-link` prints a new setup link for an owner who lost the cookie. Set `CLOUDBOT_PUBLIC_URL` to make the link use your public address.
