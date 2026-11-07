# Discord setup

You can talk to a bot from Discord direct messages. Only your Discord account
is answered. The server needs no public address, because the bot opens the
Discord Gateway connection itself.

## Make the Discord bot

1. Open the Discord developer portal (https://discord.com/developers/applications)
   and create an application.
2. In Bot, create the bot and copy its token. You do not need any privileged
   intent.
3. In OAuth2, make an invite link with the `bot` scope and no permissions. Open
   it and add the bot to a server you own. Discord only lets you send a direct
   message to a bot that shares a server with you. A private server with only
   you in it is enough.

## Connect it in CloudBot

1. Ask your bot in the web chat to connect Discord.
2. It asks for the token with a secure form. Do not paste the token in the chat.
3. The bot posts a one-time code in the chat. Send `pair CODE` to the Discord
   bot in a direct message within 10 minutes.
4. The bot answers "Connected". From then on your messages in that direct
   message go to the bot, and its replies come back there.

To stop, ask the bot to disconnect Discord. The token stays saved until you
remove it.

## What to expect

- Only your account in that direct message is answered. Server channels, other
  people and other bots get no answer at all.
- Text only. Files and screenshots stay in the web app.
- Approvals stay in the web app. Discord only gets one line that says to open it.
- Five wrong codes end the pairing. Ask the bot for a new code.
- Messages sent while the server is offline are not delivered later.
- One Discord bot token serves one CloudBot bot.
