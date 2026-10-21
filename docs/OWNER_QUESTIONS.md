# Owner questions

Some roadmap items need a product decision that the roadmap does not settle.
Work does not stop for them. Each one gets a default answer, written here, and
the work goes ahead with it. The owner can change any answer later. Changing
one means a new issue that points to the entry below.

Status: **open** means the default is in use and waits for the owner.
**Settled** means the owner confirmed or changed it.

## Desktop (#39)

### Screen stack

- Status: open
- Default: Xvfb with a small window manager (openbox), xterm and Chromium,
  shared through x11vnc on localhost. The chat will show it with noVNC through
  the server, behind the session cookie.
- Why: it matches the plan in `docs/ARCHITECTURE.md` and lets a person take
  over the real screen for the handoff.
- Other options: headless Chromium with a screencast only. It is lighter, but
  a person cannot use the terminal or other windows.

### Chromium sandbox

- Status: open
- Default: Chromium runs with `--no-sandbox`. Docker's default seccomp profile
  blocks the namespaces its sandbox needs. The container, the `bot` user and
  the missing root rights are the isolation instead.
- Other options: a custom seccomp profile in `docker/compose.yaml` that allows
  user namespaces, so Chromium can keep its own sandbox. It is safer, but the
  install gets harder to audit.

### Image size and memory

- Status: open
- Default: Debian's `chromium` package. The image grows by about 400 MB, and a
  running browser uses a few hundred MB of memory. The desktop always runs in
  the image. There is no setting to turn it off yet.
- Other options: start the desktop only when the bot first needs it, or a
  setting to turn it off on small machines.

### How the agent drives the browser

- Status: open
- Default: small browser tools in the server, connected to Chromium over the
  DevTools protocol on `127.0.0.1:9222` with Node's built-in WebSocket. The
  model works from screenshots of the page and clicks in their pixels.
- Why: no extra service and no new dependency, and the tools fit the existing
  tool server.
- Other options: a browser MCP server started for each turn.

### Desktop log

- Status: open
- Default: the desktop writes one log at
  `/home/bot/.cache/cloudbot-desktop/desktop.log`. It starts empty on each
  start of the desktop. The server log says when the desktop exits, with the
  last lines of the script's own messages, and when it starts again.

### One browser for all bots

- Status: open
- Default: every bot uses the same desktop and the same browser profile, so
  they share sign-ins. This matters once v0.5 adds more bots.
- Other options: one desktop or one browser profile per bot.

### Dialogs on web pages

- Status: open
- Default: alerts, confirms and prompts that open while the bot acts are
  closed with Cancel, and the bot is told their text.
- Other options: let the bot answer a dialog with a tool.

### Web pages and services on localhost

- Status: open
- Default: the browser shares the container's network, like the bot's shell.
  A page the bot opens could send requests to services on `127.0.0.1`, such as
  the key proxy in API key mode. Chromium's private network rules limit this,
  but it is not tested here.
- Other options: run Chromium in its own network namespace, or block
  loopback addresses for web pages with a proxy rule.

## Secure form for secrets the bot uses (#44)

- Status: open. No default yet, because it changes the rule that secrets stay
  out of reach of the bot. Work on this item waits for the owner.

## Permissions in plain language (#45)

- Status: open. No default yet. Work on this item waits for the owner.
