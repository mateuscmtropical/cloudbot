# Google apps

Gmail, Google Calendar, Google Drive, Google Docs and Google Sheets connect through
Google's own servers. Google lets no app register itself, so the admin of the
server creates one Google Cloud client once. Everyone on the server then connects
with it. Each person still signs in with their own Google account, and a bot only
gets the access of the card that was connected.

## Set up the client

1. Join the [Google Workspace Developer Preview Program](https://developers.google.com/workspace/preview)
   with the Google account that owns the Cloud project. The Google servers for
   these apps are still in preview.
2. In the [Google Cloud console](https://console.cloud.google.com/), pick or
   create a project. Under APIs and services, turn on the MCP API and the API of
   each app you want, such as the Gmail API and the Google Calendar API.
3. Set up the OAuth consent screen. While the app is in Testing, add the Google
   accounts of the people who will connect as test users.
4. Under Credentials, create an OAuth client ID of type Web application. Tick
   **Use this client for an AI-powered agent**.
5. Add one authorized redirect URI:
   - On a hub, the main address of the hub with the callback path, such as
     `https://example.com/api/apps/oauth/callback`. Every person uses this one
     address. The hub sends each browser on to its owner.
   - On a server that runs on its own, its public address with the same path,
     such as `https://bot.example.com/api/apps/oauth/callback`.
6. Copy the client ID and the client secret.

## Give it to CloudBot

Add the two lines to the install `.env`, which is `/opt/cloudbot/.env` unless
`CLOUDBOT_INSTALL_DIR` was set at install time:

```sh
CLOUDBOT_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
CLOUDBOT_GOOGLE_CLIENT_SECRET=your-client-secret
```

Then run:

```sh
sudo cloudbot update --all
```

The update starts each person's container again with the client. The client
stays in the server process. The bot and the model never see it.

A server that runs without the installer reads the same two variables from its
own environment.

## Limits

- While the Google Cloud app is in Testing, Google ends each sign-in after 7
  days. Connect the app again then, or publish the app in Google Cloud.
- Only the accounts listed as test users can sign in while the app is in Testing.
