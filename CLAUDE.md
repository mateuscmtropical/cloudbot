# Rules for agents working on CloudBot

Read [CONTRIBUTING.md](CONTRIBUTING.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/CODING_STANDARDS.md](docs/CODING_STANDARDS.md) and [docs/ROADMAP.md](docs/ROADMAP.md)
first. This file only adds what those documents do not say. Commit and pull
request details that are not listed here come from your task instructions.

## What CloudBot is

A self-hosted AI coworker that runs on the owner's VPS. It is built only on
official Anthropic piece: the `claude` CLI from the
official installer. No third-party wrappers. The interface is a messenger, and
setup happens inside the chat. API keys stay in the vault, out of reach of the
bot.

`nightly-labs/openbot` is a useful reference for hard problems. Its license is
PolyForm Noncommercial, so study the ideas only and never copy its code.

## Flow for every change

1. Pick the next item. Open issues come first. When none is left, take the
   next unfinished item of the roadmap and open an issue for it (Problem,
   Proposal, Done when). Split a large item into several issues.
2. Create a branch from the latest `main` (`feat/...`, `fix/...`, `docs/...`).
3. Implement it with tests. Run `pnpm check` until it passes.
4. Review the diff with a separate reviewer agent that cannot edit files. Ask
   it for real bugs with a failing scenario. Check each finding by hand before
   you fix it, and repeat the review after the fixes until it finds nothing
   new. Accepted limits go in the pull request.
5. Open the pull request with the template, `Closes #N` in the body and the
   issue title as the pull request title. Then comment on the issue:
   `Opened a PR for this: #M`.
6. When the checks `Lint, typecheck, test and build` and `Linked issue` pass,
   squash-merge it:

   ```sh
   gh pr merge M --squash --subject "<title> (#M)" --body-file <file>
   ```

   The body file holds `Closes #N`, a blank line and the commit trailers
   given in your task instructions.
7. Delete the branch and start again from step 1.

One pull request per issue. Never push to `main` directly.

## Text rules

These apply to docs, comments, the CHANGELOG, issues, pull requests and commit
messages.

- English, short sentences.
- No em dash or en dash characters. No semicolons in prose. Before you post,
  search the text for `[—–;]` outside code blocks.
- Write files and request bodies as UTF-8 without a byte order mark.
- User-facing changes get an entry under `## [Unreleased]` in `CHANGELOG.md`,
  and the README or docs are updated when behavior changes.

## Security limits

- Never collect, store, log or broker Claude.ai credentials or session tokens.
  CloudBot may pass a sign-in code to the official CLI and nothing more.
- Never log or store a sign-in code or an API key.
- Never sign in with a real account and never use real credentials. Tests use
  fakes. A manual test may use an obviously fake key against a local server.
- Never build anything that solves a CAPTCHA or another bot check. The screen
  goes to the person.
- Tests never call Claude or the network.

## Testing for real

Try every user-facing change in a real browser when the environment allows
it. Write in the pull request what you tried, and say plainly what you could
not try, such as a real Claude sign-in or a real usage limit.

## When to stop and ask

Stop and leave a comment on the issue instead of guessing when a change needs
a product decision the roadmap does not settle, a new paid service, a change
to the security limits above, or access you do not have.
