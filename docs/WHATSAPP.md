# WhatsApp setup

CloudBot receives WhatsApp messages through Meta's official WhatsApp Business
Cloud API webhook. It never sends WhatsApp messages. The server needs a public
HTTPS address for Meta to reach it.

## Set up in CloudBot

Ask a bot in the web chat to connect WhatsApp. Give it the numeric Phone number
ID from the Meta app's WhatsApp API Setup page. The bot posts secure forms for
the Meta App Secret, a verify token and the WhatsApp number that may send
instructions. Enter each value in its form. Do not send these values as chat
messages.

Find the App Secret in the Meta app under App settings, Basic. Choose a verify
token and keep it for the Meta setup below. Enter the allowed WhatsApp number
in international format. When setup finishes, the bot gives you a callback URL.

## Set up in Meta

1. Create a Meta for Developers app and add the WhatsApp product.
2. Connect a WhatsApp Business Account and phone number to the Cloud API. Copy
   the numeric Phone number ID from WhatsApp API Setup. Give that ID to the bot
   in the CloudBot chat.
3. In WhatsApp Configuration, set the callback URL from CloudBot and the same
   verify token you entered in CloudBot. Verify and save the webhook.
4. Subscribe the app to the `messages` webhook field.

Send a text from the allowed WhatsApp number to the phone number connected to
the Cloud API. The message starts a normal chat turn. The reply appears in the
CloudBot web app. Existing push notices arrive when notifications are enabled.
CloudBot sends no WhatsApp reply. Other sender numbers are silently ignored.
Non-text messages get a short note in the chat.

Disconnect WhatsApp with the bot's `whatsapp_disconnect` tool. Remove the
webhook from the Meta app too.
