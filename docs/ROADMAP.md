# Roadmap

Each version is usable on its own. Every item becomes an issue before work
starts.

## v0.1: talk to it

- One-command install on a VPS, plus `cloudbot update`, `cloudbot status` and
  `cloudbot logs`.
- Messenger style chat: bots on the left, conversation in the middle, message
  box with attachments.
- Setup inside the chat. The bot asks for a subscription or an API key, signs
  you in through Anthropic's page or takes the key through a secure form, then
  says it is ready.
- The bot works on its own and shows what it is doing.
- Conversations and the bot's memory survive restarts.
- Name, title and description, changed from the chat.
- When the subscription limit is reached, the task waits for the reset and
  continues.
- Access through a one-time setup link printed by the installer.

## v0.2: the bot's computer

- A desktop with Chromium and a terminal. The bot browses, fills in and sends
  forms, creates accounts and changes settings.
- Screenshots in the chat.
- Sign in to sites such as X, Reddit or LinkedIn once, on the bot's screen. The
  session stays in the bot's browser.
- Screen handoff. When a site needs a person, the bot opens its screen in the
  chat and pauses. "Done, take over" gives the screen back. "I will keep it"
  keeps the bot paused. The bot never acts while a person has the screen.
- Secure form for passwords, codes and payment details.
- Files: spreadsheets, documents, PDFs, slides and charts, plus downloads from
  the chat.

## v0.3: safe autonomy

- Permissions in plain language, with allow and block lists.
- A review agent before sensitive actions. Messages sent on your behalf,
  purchases and bookings always need your approval.
- Routines, scheduled from the chat.
- Event triggers: watch a page, webhooks.
- Spending and time limits per task and per routine.

## v0.4: connectors and APIs

- "Connect apps" screen: Claude connectors with a subscription, official remote
  MCP servers, or any MCP server by URL.
- APIs: give the bot a key through the secure form and it builds and maintains
  the integration on the VPS. Only the integration process receives the key.
- Code: the bot works on repositories in its own computer and opens and
  reviews pull requests.

## v0.5: a team of bots

- Several bots, created with "+" or from the chat.
- Bots pass tasks and messages to each other.
- Group chats and project channels with a roster and a manager bot.
- A simple task board with a Blocked status that notifies you.

## v0.6: share and teach

- Export and import a bot as a template, without secrets or personal memories.
- A public template gallery backed by a GitHub repository.
- Teach a task by recording the screen.
- Voice input.

## Later

- A real sign-in (passkey or similar).
- Installable PWA, Telegram, WhatsApp (receiving instructions only) and Claude
  Remote Control.
- An email inbox for the bot and joining meetings with transcripts.

## Not planned

- Solving CAPTCHAs or other bot checks. CloudBot always hands those to a person.
