# Many people on one server

The owner installs CloudBot on a VPS and invites a few people. Each person gets
their own CloudBot with their own bots, chats, vault and AI provider login. The
owner decides who has access. This page is the design. The code is split in the
parts below.

## Why one container per person

CloudBot has one owner. Its session, vault, provider logins and workspaces are
global, and all bots run as the same Linux user. Sharing one process between
people would need an owner on every table, route and tool, and one missed check
would leak a chat. Instead each person runs a full CloudBot in a container. The
kernel keeps them apart, and the existing code needs almost no change.

## Parts

```text
browser --> Caddy --> hub --> instance of maria   (own network, own volumes)
                        |---> instance of joao
                        |---> instance of the owner
                        '---> docker socket proxy --> Docker
```

- **Caddy** terminates HTTPS for the domain and for `*.domain`. It asks the hub
  before it gets a certificate for a name, so only known names get one. A
  wildcard DNS record is enough, with no DNS provider key.
- **Hub** is a small service from the same image, started with
  `node dist/hub/main.js`. It keeps the people, signs them in, starts and stops
  their containers and proxies traffic to them. It listens on port 3001 inside
  the compose network.
- **Docker socket proxy** is a stock `tecnativa/docker-socket-proxy` container.
  It allows only the container, network and volume calls the hub needs. The hub
  never mounts the Docker socket.
- **Instance** is the normal CloudBot server in its own container, named
  `cloudbot-i-<name>`. It has its own network `cloudbot-net-<name>`, and the hub
  is the only other member. So instances cannot reach each other. It has four
  volumes: `cbi-<name>-data`, `-home`, `-workspaces` and `-uploads`.

The first instance belongs to the owner. The owner is a person like the others,
with the role `owner`.

## Addresses and cookies

A person opens `https://<name>.<domain>`. The apex `https://<domain>` shows a
page that asks for the name and sends the person to their address. Every
subdomain is its own origin, so cookies and local storage are never shared. The
hub session cookie is bound to the host, without a `Domain` attribute.

Google takes one redirect address per client, so Google sign-ins come back to
`https://<domain>/api/apps/oauth/callback`. The state starts with the person
name and a dot. The apex sends an active person's browser on to the same path on
their own address, with the query unchanged. See [GOOGLE.md](GOOGLE.md).

## The request path

1. The browser asks `maria.example.com`. Caddy sends it to the hub.
2. The hub reads the `Host`. A name that is not a person gets a 404.
3. Without a valid hub session the hub shows the login page. After a correct
   name and password it sets the session cookie.
4. If the instance is stopped, the hub shows the loading page, starts the
   instance and the page continues by itself.
5. The hub proxies the request to the instance. It removes any
   `x-cloudbot-hub` header from the browser, adds its own with the secret of that
   instance and keeps the `Host`. It proxies server sent events and WebSockets
   the same way.
6. The instance sees the header, checks the secret and treats the request as the
   signed in owner of that instance. It has no setup link and no passkeys of its
   own in this mode. The hub signs people in.

The header names and the admin API are in `src/shared/hubProtocol.ts`.

## Settings of an instance

The hub passes these to each container it makes.

| Variable | Meaning |
|---|---|
| `CLOUDBOT_HUB_SECRET` | Random, made when the person is added. Turns the hub mode on. |
| `CLOUDBOT_HUB_URL` | `http://hub:3001`, reachable on the instance network. |
| `CLOUDBOT_PERSON_NAME` | The name of the person. |
| `CLOUDBOT_PERSON_ROLE` | `owner` or `member`. |
| `CLOUDBOT_PUBLIC_URL` | `https://<name>.<domain>` |

`readHubConfig` in `src/server/people/hubConfig.ts` reads them.

## The admin API

Only the owner's instance may call it, with its name and secret in headers. The
panel and the bot tools call it through `HubClient`, so the browser and the model
never talk to the hub admin API. A new person gets a generated password. It is
returned once, shown once, and never goes to the model, the messages, the logs
or the database of any instance.

## Memory budget

Every instance has a memory cap, 2560 MB by default. The hub keeps the sum of
the caps of running instances under a total budget, 10240 MB by default. When
one more instance would pass it, the person sees a page that says the server is
busy and to try again soon. Both numbers are settings of the hub.

## Idle instances

After five minutes without a request, the hub asks the instance for
`GET /api/hub/activity`. A running turn, an enabled routine, a page watch, a
webhook, a WhatsApp, Telegram or email connection, or a program the bot user
started that listens on a port, such as a Node dev server, keeps it awake.
The desktop's own ports do not count. Otherwise the hub stops it. The next sign-in starts it again.

## Security notes

- The hub holds no Docker socket. The socket proxy allows containers, networks
  and volumes, and nothing else.
- The hub makes containers only from the image of the running hub, with fixed
  options and a validated name. No setting from a person reaches the Docker call.
- Passwords are hashed with scrypt. Sign-in attempts are limited by name and by
  address.
- Each instance has its own secret. A leaked secret opens one instance.
- An instance cannot reach another one or the hub admin API as another person.

## Work split

Each part is one pull request. These folders belong to one part, so the parts do
not collide.

| Part | Issue | Owns |
|---|---|---|
| Design and contracts | #241 | this page, `src/shared/peopleTypes.ts`, `src/shared/hubProtocol.ts`, `src/hub/contract.ts`, `src/hub/passwords.ts`, `src/hub/store/`, `src/server/people/` |
| Containers | #242 | `src/hub/docker/`, `src/hub/instances/`, `src/hub/admin/`, `src/hub/main.ts`, `src/hub/config.ts` |
| Front door | #243 | `src/hub/auth/`, `src/hub/proxy/`, `src/hub/pages/`, `src/server/access/` hub mode |
| People panel | #244 | `src/server/people/createPeopleRoutes.ts`, `src/web/components/PeoplePanel.tsx` |
| Bot tools | #245 | `src/server/people/createPeopleTools.ts` |
| Idle instances | #246 | `src/hub/idle/`, `src/server/hub/` activity route |
| Fingerprint and face | #247 | `src/hub/passkeys/` |
| Install | #248 | `docker/`, `docs/INSTALL.md`, CI |

Every part adds its own CHANGELOG line and its own section in this page or in
`docs/ARCHITECTURE.md`.

## Trying it on one machine

A browser resolves `*.localhost` to the local machine, so
`http://maria.localhost:3200` reaches the hub with no DNS and no certificate.
The hub accepts plain HTTP only when `CLOUDBOT_DOMAIN` is `localhost`. In that
mode it sets the session cookie without the `Secure` flag, since there is no
HTTPS. Instances keep `Secure` on their own cookie, which the hub mode does not
use.

## Owner people panel

The owner's instance exposes `/api/people` only when it has the hub people admin client. The web app checks that route before it shows the People button. All panel routes sit behind the owner's session and the same-origin check.

The panel lists the access state, the instance status, the address and the last seen time of each person. The owner can add a person, deactivate or reactivate them, reset a password, or delete them after typing their name.

A new or reset password appears with the address in a one time card. The card stays in component state only. It disappears when the owner closes the panel or selects "I saved it".

## Passkey sign-in

The hub stores each passkey in the `hub_passkeys` table, keyed by person and credential id. Deleting a person deletes their passkeys. Each person can register up to ten.

`HubPasskeyService` makes discoverable credentials with required user verification and no attestation. A challenge is signed by the hub, binds the operation to its person, address and origin, expires after five minutes and works once. A production address is `https://<name>.<domain>`. With `CLOUDBOT_DOMAIN=localhost` the origin is the local HTTP address with its port.

`createHubPasskeyRoutes` serves these routes at the root of the hub:

- `POST /__hub/passkey/register/options` and `POST /__hub/passkey/register/verify` need the signed in person.
- `POST /__hub/passkey/login/options` and `POST /__hub/passkey/login/verify` are public and sit behind the same-origin check.
- `GET /__hub/passkey/list` and `DELETE /__hub/passkey/:id` need the signed in person.
- `GET /__hub/passkey/offer` shows the one time offer after a password sign-in.
- `GET /__hub/passkeys` shows the passkeys of the person. It can remove one, or add one for the device in use.

The front door passes the tenant of the request, the signed in person, the session check, the session cookie writer, the same-origin check and a page renderer. It appends `passkeyLoginExtras()` to the sign-in page and connects `createAfterLogin` to the redirect after a password sign-in. The offer appears only for a person without passkeys, and "Not now" stores a skip cookie for 180 days.

A passkey proves who the person is. The front door still checks that the person is active before it starts the session.

## Bot tools for people

The bots of the owner get five tools when the instance has the hub people admin client: `person_list`, `person_add`, `person_deactivate`, `person_reactivate` and `person_reset_password`. A member's instance has none of them. No tool deletes a person. Deleting stays in the panel, where the owner types the name.

`person_add`, `person_deactivate` and `person_reset_password` each show an approval card with the name of the person. The general tool review does not ask a second time for them.

The tools never return a password. After an add or a reset, the server sends a `personCredentials` event to the web app of the owner, which shows the address and the password in a notice with Copy and Hide buttons. The event is not a chat message, so it is not stored and not logged. When no web app is open, the server keeps the event in memory until one subscribes. A restart of the server drops an undelivered event, and the owner resets the password from the panel.

A failed call returns a short generic result to the model. The details of the hub error stay out of the chat.

## Hub settings

The hub reads `CLOUDBOT_DOMAIN`, `CLOUDBOT_LOGIN_ALLOWED_IPS`, `HUB_PORT`, `HUB_HOST`, `HUB_DATA_DIR`, `DOCKER_API_URL`, `CLOUDBOT_INSTANCE_IMAGE`, `CLOUDBOT_INSTANCE_MEMORY_MB`, `CLOUDBOT_INSTANCE_BUDGET_MB`, `CLOUDBOT_INSTANCE_CPUS`, `CLOUDBOT_OWNER_NAME` and `HUB_CONTAINER_ID`. Only `CLOUDBOT_DOMAIN` is required. The hub container id defaults to `HOSTNAME`.

Each person gets a container, a bridge network and four named volumes. The network is not internal, so the instance reaches AI providers and the web. Another network cannot reach it. The hub joins the network as `hub`, and it leaves the network before the network is removed. The instance has no published ports and fixed memory and CPU caps. The hub checks the total memory cap before it starts an instance and waits up to two minutes for its health check.

A new hub has no owner. The first person who opens the address of the owner chooses a password, and the hub creates the owner and the instance of the owner. Until then every other address answers not available. The page closes as soon as the owner exists. `node dist/hub/main.js reset-password <name>` prints a replacement password.

## Front door

`createFrontDoorRoutes` handles every request that is not under `/internal`. The host decides what happens. The apex shows a short page. A person's address (`<name>.<domain>`) needs a session of that person. An unknown or inactive name gets a not available page that looks the same.

The routes under `/__hub/` on a person's address are the hub's own: `login`, `password`, `logout` and `status`. Everything else goes to the instance through `cloudbot-i-<name>:3000`. The hub removes the session cookie and the trust header from the browser request, then sets the trust header with the secret of the instance. `attachUpgradeProxy` does the same for WebSockets and checks the session and the origin before it connects.

Sessions live in the hub database as hashes of random tokens. A session ends after 7 days, so each person signs in again once a week. The cookie is host only, `HttpOnly`, `SameSite=Lax`, and `Secure` when the domain is not `localhost`. Lax keeps the person signed in when the app opens from its icon, a notification or another app. Requests that change state still need the same origin. A person with a new password can only reach the change password page. A change signs out the other sessions of that person.

When `CLOUDBOT_LOGIN_ALLOWED_IPS` is set, the hub checks the client address from Caddy before serving the sign-in page or accepting password and passkey sign-ins. It also checks password changes. Existing sessions can still use the site. Keep the hub behind Caddy so the forwarded client address is trusted.

Five failed sign-ins lock the name and the address for 15 minutes. The sign-in page never says whether the name or the password was wrong.

When the instance is not running, the hub starts it and shows the loading page, which asks `/__hub/status` until the instance is ready. A start that does not fit the memory budget shows a busy page.

In hub mode an instance accepts a request with the trust header and the right secret as the owner session. It has no setup link, no passkeys of its own and no `/setup` route.

## Wiring

`main.ts` opens the people, login-session and passkey tables on the hub database. It shares one idle watcher between the front door and WebSocket proxy, starts it after the hub listens, and stops it during shutdown. `createHubApp` mounts health and TLS checks, then the internal admin API, passkey routes and the front door. Internal routes accept only `hub:3001` or loopback Hosts on the configured hub port, so a public person address gets the same generic 404 as an unknown hub route.

## Install

The Compose stack runs the hub, the Docker socket proxy and Caddy. The hub and per-person instances use the same `cloudbot:local` image. The hub stores its records in the `hub-data` volume. Instance data stays in separate `cbi-*` volumes.

The socket proxy is reachable only from the hub on the internal `hubctl` network. It permits container, network and volume operations. Caddy sends requests to the hub and asks it before issuing an on-demand certificate. The `localhost` configuration serves plain HTTP for local checks.

The installer writes the domain, owner name, memory budget and per-instance limits to `.env`. The defaults are a 10240 MB running-instance budget, 2560 MB per instance and 2 CPUs per instance. Idle instances hibernate after five minutes by default.

`cloudbot update` pulls code and service images, rebuilds the shared image and recreates the hub. Existing instance containers keep the image they were created from, and `cloudbot update --all` removes the ones on an old image. Removing an instance container leaves its `cbi-*` volumes in place, and the hub recreates it on the next request. Back up `hub-data` and all `cbi-*` volumes together.
