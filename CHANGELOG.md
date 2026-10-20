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
- SQLite storage for bots, messages and settings with Drizzle ORM, with migrations that run on start.
- Agent runner that streams one conversation turn through the Claude Agent SDK.
- Chat web interface in `src/web`: bot list, Markdown messages, setup messages and a composer. The server serves the build from `dist/web`.
