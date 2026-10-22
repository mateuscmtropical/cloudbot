# Provider terms

CloudBot does not sell, resell or pay for Claude usage. You connect your own
Claude subscription or your own Anthropic API key, and your agreement with
Anthropic applies to all usage. Anthropic can limit or close an account that
breaks its terms. The other providers work the same way, see
[other providers](#other-providers).

This page is not legal advice. It says how CloudBot runs Claude and quotes what
Anthropic publishes.

## How CloudBot runs Claude

- CloudBot runs the official Claude Code CLI (`claude`) for each turn, and the
  CLI sends all requests to Anthropic.
- The CLI is installed with Anthropic's installer and is never modified.
- **Subscription.** CloudBot starts `claude auth login --claudeai` in a pseudo
  terminal and reads the sign-in link. You open that link on your own device,
  sign in on Anthropic's page and paste the code that page
  shows into the chat. CloudBot passes the code to the CLI. The CLI stores the
  credentials, and CloudBot does not read, copy or store them.
  CloudBot confirms sign-in with `claude auth status --json` and uses only the
  login state and authentication method.
- **API key.** You paste the key into a secure form. CloudBot keeps it in its
  vault, out of reach of the bot.

## What Anthropic says

From Anthropic's
[legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance),
read on 2026-10-20:

- "Developers building products or services that interact with Claude's
  capabilities, including those using the Agent SDK, should use API key
  authentication through Claude Console or a supported cloud provider."
- "developers may not collect, store, or intermediate Claude.ai credentials or
  session tokens"
- It does not "prevent an end user from signing in to the unmodified Claude
  Code binary with their own Claude subscription, including where a platform
  hosts Claude Code".
- "Advertised usage limits for Pro and Max plans assume ordinary, individual
  usage of Claude Code and the Agent SDK."

## What this means for you

| Use | Notes |
|---|---|
| API key | The method Anthropic asks products that interact with Claude's capabilities to use. |
| Your own subscription, only you use the bot | You sign in to the unmodified CLI on Anthropic's page. CloudBot carries the sign-in code from the chat to the CLI, and Anthropic has not confirmed this flow to the project. Bots that run on their own can go past "ordinary, individual usage". |
| Other people use the bot with your subscription | Do not do this. Each person needs their own plan or key. |

Anthropic has not reviewed CloudBot. For your own case, Anthropic tells you to
[contact sales](https://www.anthropic.com/contact-sales).

## Other providers

The same rules hold for every other provider. CloudBot does not sell, resell
or pay for their usage either.

- CloudBot runs the provider's official CLI, installed from the provider's own
  npm package or install script and never modified. The versions are pinned in
  `docker/Dockerfile`.
- **Subscription.** CloudBot starts the CLI's own login command and posts the
  link and code that it prints. You sign in on the provider's page. The CLI
  stores the credentials in the agent user's home, and CloudBot does not read,
  copy or store them. CloudBot never asks for your password.
- **API key.** The key stays in the vault and reaches the provider through the
  local key proxy, as with Anthropic.
- Your agreement with each provider applies. A plan made for one person at a
  keyboard may limit bots that run on their own, shared use or automated use.
  Read the provider's terms before you connect a subscription, and prefer an
  API key when the terms ask for one.

None of these providers has reviewed CloudBot.
