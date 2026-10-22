# Security policy

CloudBot runs a bot with a browser, a terminal and your logins. A security
problem here can be serious. Please report it in private.

## Report a vulnerability

Do not open a public issue or pull request for a security problem. Use a
private security advisory instead:

1. Open the [new advisory form](https://github.com/mateuscmtropical/cloudbot/security/advisories/new).
2. Describe the problem.

Include as much of this as you can:

- What the problem is and what an attacker could do with it.
- The version or commit, and whether you run Docker or local mode.
- The operating system and how CloudBot was installed.
- Steps to reproduce it.

Use fake keys, tokens and passwords to show the problem. Never send a real
one.

## Supported versions

CloudBot has no tagged release yet. Only the latest `main` gets security
fixes.

## What is in scope

- The server, the web app, the Docker image, the compose file and the install
  script in this repository.
- A way for the bot, a web page, a webhook caller or a stranger to get past a
  protection that the [threat model](docs/THREAT_MODEL.md) describes. For
  example: reading the vault or the data folder from the bot in Docker mode,
  getting the API key, making the browser reach a private address through the
  gate, running a command the floor should refuse, skipping an owner approval,
  using the owner session without the setup link, or making CloudBot log or
  store a secret.
- A mistake in the docs that makes an install unsafe.

## What is out of scope

- The [known limits](docs/THREAT_MODEL.md#known-limits) listed in the threat
  model. If you find a way past a protection that the page does not list as a
  limit, that is in scope.
- Local mode. The bot runs as you there and can read your files. This is
  documented and CloudBot prints a warning at start.
- A model that is fooled by text it reads. That is expected, and the approvals,
  the floor and the vault exist for it. A way around those is in scope.
- Bugs in the Claude CLI, the Claude Agent SDK or Anthropic's API. Report those
  to Anthropic.
- A vulnerability in a dependency that CloudBot code cannot reach. Report it to
  the dependency. Tell us if CloudBot is affected.
- Attacks that already need the owner's session cookie, a shell on the server
  or root on the host.
- Volume based denial of service and scanner output without a working attack.

## What to expect

These are goals, not promises:

- We acknowledge the report within a week.
- We keep you updated while the fix is prepared.
- The fix ships on `main`. We publish an advisory after it ships and credit you
  if you want that. Please keep the details private until then.

Good faith research on your own install is welcome. Do not test against
servers that belong to other people.
