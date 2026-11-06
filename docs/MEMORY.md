# Long-term memory

The bots can keep notes that outlast one conversation. CloudBot runs
[ai-memory](https://github.com/akitaonrails/ai-memory), a single binary under the
MIT license, beside the server. The bot reaches it over MCP as `memory`, so its
tools are named `mcp__memory__<tool>`. `MEMORY.md` stays for the short notes that
every conversation needs.

## On and off

`CLOUDBOT_AI_MEMORY` is `on` by default. To turn it off, set `off` in
`/opt/cloudbot/.env` and run `sudo cloudbot update --all`. The `--all` flag
makes the running instances again with the new setting. Without the binary in the
image, memory stays off and nothing changes.

## How it works

- The server starts `ai-memory serve` on `127.0.0.1:9226`, with its store in
  `<data dir>/ai-memory`. Only the server user can write there, and the bot user
  cannot read it. The config turns off local embeddings, so no model is downloaded.
- The server starts the process again when it exits. A turn gets the memory server
  only after it answers.
- Claude and Codex turns get the memory server. ACP providers and agy do not, yet.
  Their permission path would send each memory call to the review model.
- Five tools run without a review card: `memory_query`, `memory_read_page`,
  `memory_write_page`, `memory_handoff_begin` and `memory_handoff_accept`. Any
  other tool of the server goes through the review like a connector tool.
- Each bot uses the workspace `cloudbot` and its own id as the project. A saved
  app cannot take the name `memory`.

## Limits

- All bots of one server share one container. The project name is a rule in the
  prompt, not a lock, so a bot could read the project of another bot.
- Memory writes do not wait for the owner. A web page that makes a bot save a bad
  note can reach its later conversations. The prompt tells the bot to treat
  memory as data, not as instructions.
- Helper turns, such as search, browsing and documents, get no memory server.
