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

### Live view is view only

- Status: open
- Default: the Screen panel is view only unless the owner holds the screen.
  The server proxy reads the VNC messages from the browser and drops key,
  pointer and clipboard messages while the bot holds the screen. It closes the
  connection for a message type it cannot frame.
- Why: the roadmap says the bot never acts while a person has the screen, and
  that needs the handoff state first.
- Other options: let the owner control the screen at any time.

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
  they share sign-ins. Two bots that use the browser at the same time would
  also mix up the dialog notes. This matters once v0.5 adds more bots.
- Other options: one desktop or one browser profile per bot.

### Dialogs on web pages

- Status: open
- Default: alerts, confirms and prompts that open while the bot acts are
  closed with Cancel, and the bot is told their text. A leave-page dialog is
  accepted, so unsaved changes on that page are lost.
- Other options: let the bot answer a dialog with a tool.

### Web pages and services on localhost

- Status: open
- Default: the browser shares the container's network, like the bot's shell.
  A page the bot opens could send requests to services on `127.0.0.1`, such as
  the key proxy in API key mode. Chromium's private network rules limit this,
  but it is not tested here.
- Other options: run Chromium in its own network namespace, or block
  loopback addresses for web pages with a proxy rule.

### Screen handoff (#65)

- Status: open
- Default: one holder for the whole desktop, `bot` or `person`, kept in memory.
  After a restart the bot holds the screen again. The bot gives the screen away
  with `request_screen`. Only the owner takes it back, through the session
  routes, because the bot has no tool for it. While the owner holds it, the
  `browser_` tools refuse. Giving the screen back does not start a turn. The
  owner sends the next message.
- Limits: the guard covers the `browser_` tools and the live view. The bot's
  shell shares the container, so it could still reach x11vnc on `127.0.0.1:5900`
  or the DevTools port directly, as the localhost entry above says. A browser
  action that is already running when the owner takes the screen finishes. Pointer
  moves from the owner that arrive after the screen goes back are dropped.
  Key releases and button releases always pass. The live view accepts only RFB 3.8 and
  closes on message types it does not know, such as desktop resize.
- Other options: one holder for each bot, which matters when v0.5 adds bots
  that share one browser.

## Document tools (#69)

- Status: open
- Default: Python 3 from Debian with `openpyxl`, `python-docx`, `python-pptx`,
  `reportlab`, `pypdf` and `matplotlib`, plus `poppler-utils`. The image grows
  by roughly 150 MB. The bot writes files in its workspace and sends them with
  `share_file`.
- Limits: there is no office suite, so the bot cannot convert a document to
  PDF or render a slide to an image.
- Other options: add LibreOffice for conversion and rendering. It adds several
  hundred MB.

## Secure form for secrets the bot uses (#44)

- Status: open
- Default: the bot asks with `request_secret` and gives the https site where
  the value will be used. The value goes to the vault, tied to the bot and the
  site. The model never sees it. The server types it into the browser only on
  that site, and only into a password, one-time code or card field. Names that start with `ANTHROPIC_` or
  `CLAUDE_` are refused, so a bot form cannot pass for the setup form. Passwords, codes and payment details use the same form.
- After the owner saves a value, the bot waits until the owner tells it to
  continue. It does not start a turn on its own.
- Other options: let the bot read the value, or start the next turn by itself
  when the form is saved.

## Permissions in plain language (#45)

- Status: open
- Default: rules live per bot, at most 50. Only the owner changes them,
  through owner-only routes and the Rules panel in the web app. The bot has no tool for them, so a
  web page cannot talk it into more rights.
- Each rule is a sentence. Every sentence goes into the system prompt as an
  owner rule. Block rules can also name tools, such as `Bash(rm:*)` or
  `WebFetch`, and the SDK refuses those through `disallowedTools`.
- An allow rule cannot name tools, so it never widens what the bot can do.
- A tool name must be spelled as the SDK spells it. A wrong name blocks
  nothing, and `Bash(rm:*)` blocks only commands that start with `rm`, so a
  sentence is still needed for the intent.
- A blocked call is refused by the SDK, and the bot continues. A review agent
  that checks each call against the sentences is the next roadmap item.
- Other options: rules for all bots at once, or a turn that pauses and asks the
  owner when a call is blocked.

## Approval before sensitive actions (#71)

- Status: open
- Default: a paused call waits at most one hour for the owner. Silence, Stop
  and a restart all count as Deny. The owner answers in the chat with Approve
  or Deny. There is no "always allow" button yet.
- A reviewer that fails asks the owner instead of letting the call run.
- Which calls are sensitive is decided by the review agent (#72).
- Other options: a longer wait, or a notification outside the chat.

## Review agent (#72)

- Status: open
- Default: every call except reading and looking tools is reviewed by a
  separate model call with no tools. Messages, purchases and bookings always
  ask the owner. A model that fails asks the owner too.
- Cost: one extra model call per reviewed call. This uses the same sign-in as
  the bot.
- Other options: review only some tools, use a cheaper model, or let the owner
  pick which actions always ask.
