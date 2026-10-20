# Contributing to CloudBot

Thank you for helping. This guide covers setup, the checks every change must
pass and how to send a pull request.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

Read these documents first:

- [Architecture](docs/ARCHITECTURE.md) explains the processes, the folder
  layout and the rules between folders.
- [Coding standards](docs/CODING_STANDARDS.md) explains the style rules. Lint
  enforces most of them, and the rest are checked in review.
- [Roadmap](docs/ROADMAP.md) shows what is planned for each version.

## Issues first

Every change starts with an issue, even a small one:

1. Open an issue that says what is wrong or what is missing. For a large
   change, wait until we agree on the approach.
2. Open a pull request with `Closes #N` in its description, where `N` is the
   issue number.
3. Comment on the issue with the pull request link.

A pull request without a linked issue fails the `Linked issue` check and
cannot be merged. Dependabot pull requests are the only exception.

## Setup

You need Node 24 or newer and pnpm 10.

```sh
pnpm install
pnpm dev
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Starts the server and restarts it on changes |
| `pnpm lint` | Checks the code with ESLint |
| `pnpm lint:fix` | Fixes the problems ESLint can fix |
| `pnpm typecheck` | Runs the TypeScript compiler without writing output |
| `pnpm test` | Runs the test suite once |
| `pnpm build` | Builds the server into `dist` |
| `pnpm check` | Runs lint, typecheck, tests and build |

Run `pnpm lint:fix` before you commit. Run `pnpm check` before you open a pull
request. It must pass.

## Branches

Create a branch for each change. Start the name with the kind of change:

- `feat/...` for a new feature, for example `feat/chat-history`.
- `fix/...` for a bug fix, for example `fix/setup-link-expiry`.
- `docs/...` for documentation only, for example `docs/install`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/). Write the
type first, then a short description:

```text
feat(chat): keep the history after a restart
fix(vault): refuse an empty key
```

Common types are `feat`, `fix`, `docs`, `chore`, `test`, `ci` and `refactor`.

## One change per pull request

Keep each pull request to one logical change. A bug fix and a refactor belong
in two pull requests. Small pull requests are reviewed faster.

## Tests

Changes need tests. Every module with logic ships with tests next to it, in a
file named `name.test.ts`. Test names describe the behavior, for example
`it('waits for the reset when the usage limit is reached')`.

Tests never call Claude. Use the fake agent from the test helpers instead, so
the suite runs offline and costs nothing.

## Testing for real

For changes that touch the agent, the setup or the install, also try them for
real before you ask for a review: install CloudBot on a Linux machine or a VM,
connect Claude and run the flow you changed. Write what you tried in the pull
request.

## Pull request checklist

Use the pull request template. Before you ask for a review, check that:

- The description links the issue with `Closes #N`.
- `pnpm check` passes.
- Tests are added or updated.
- The docs and `CHANGELOG.md` are updated when the behavior changes.

## Reporting bugs and security problems

Report a bug by opening an issue with the bug report form.

Do not report security problems in a public issue. Read the
[security policy](SECURITY.md) instead.

## License

The project is released under the MIT license. See [LICENSE](LICENSE).
