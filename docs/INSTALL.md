# Install CloudBot on a VPS

CloudBot runs on a VPS as a hub. The hub creates a separate CloudBot container
for each person. The owner controls access from the People panel in the owner
instance.

## What you need

- A Debian 12 or newer, or Ubuntu 22.04 or newer VPS with a public IPv4 address
  and root or sudo access.
- An x86-64 or an ARM (arm64) processor. CI builds and installs CloudBot on both,
  for example on Oracle Always Free ARM machines.
- A domain you control for production. You can instead use a free
  `<ip-with-dashes>.sslip.io` name when you do not provide one.
- TCP ports 80 and 443 open to the VPS. Caddy uses port 80 for certificate
  requests and port 443 for HTTPS.

For your own domain, point both of these DNS `A` records at the VPS public IP:

| Name | Type | Value |
|---|---|---|
| `example.com` | `A` | Your VPS public IP |
| `*` | `A` | Your VPS public IP |

The wildcard record covers the owner and each person's subdomain. The installer
checks the apex and a random subdomain. It warns and continues when DNS does not
point at the server. Caddy cannot get certificates until DNS and ports 80 and
443 are correct.

## Install

Run the installer on the VPS. Pass the domain first and an optional owner name
second. The default owner name is `owner`.

```sh
curl -fsSL https://raw.githubusercontent.com/mateuscmtropical/cloudbot/main/docker/install.sh | sudo bash -s -- example.com owner
```

Without a domain argument, the installer reads the public IP and uses its
`sslip.io` name:

```sh
curl -fsSL https://raw.githubusercontent.com/mateuscmtropical/cloudbot/main/docker/install.sh | sudo bash
```

The installer installs Docker when needed, builds the image, starts the hub,
the restricted Docker socket proxy and Caddy, then waits for the hub health
check. It prints the owner's address and the first password. It also installs
the `cloudbot` command in `/usr/local/bin`.

The owner address is `https://owner.example.com`. On the first sign-in, enter
the printed password and choose a new one when asked. Then connect an AI
provider in the chat.

The special domain `localhost` is for local checks. It uses plain HTTP at
`http://owner.localhost` and does not request a public certificate.

## Add people and set limits

Open the People panel in the owner's CloudBot to add, deactivate, reactivate or
remove people, or reset their passwords. A new person gets their own address,
CloudBot container and one-time password.

By default, each running instance has a 2560 MB memory limit and the hub allows
up to 10240 MB of combined instance memory limits. This normally allows four
instances at their default limit. Each instance is also limited to 2 CPUs by
default. The budget applies to running instances. If starting an instance would
exceed it, the person can try again when memory is available.

Change `CLOUDBOT_INSTANCE_MEMORY_MB`, `CLOUDBOT_INSTANCE_BUDGET_MB` or
`CLOUDBOT_INSTANCE_CPUS` in `/opt/cloudbot/.env`, then apply the settings with:

```sh
sudo cloudbot update
```

The hub hibernates an idle instance after five minutes by default. An active
turn, a program a person started that listens on a port, or another activity that needs the instance keeps it awake. A later visit
starts a hibernated instance again.

## Commands and updates

| Command | What it does |
|---|---|
| `sudo cloudbot status` | Shows the hub, Docker socket proxy, Caddy, instances and instance memory use |
| `sudo cloudbot logs` | Follows hub logs. Press Ctrl+C to stop. |
| `sudo cloudbot update` | Pulls code and service images, rebuilds the CloudBot image and recreates the hub |
| `sudo cloudbot reset-password [name]` | Prints a new one-time password. The default name is `owner`. |

After an update, instances that are already running continue on their existing
image. To recreate one on the new image, remove its container:

```sh
sudo docker rm -f cloudbot-i-maria
```

The person's `cbi-*` volumes stay in place. The hub creates the container from
the new image on the person's next request.

## Back up data

Back up the `hub-data` volume and every `cbi-*` volume. The hub volume contains
the people records. Each person's volumes contain their CloudBot data, provider
sign-ins, workspaces and uploads. Stop the hub and instances first so SQLite
and their files are consistent. This example writes one archive per volume to
`./cloudbot-backup`:

```sh
sudo docker pull alpine:3.20
sudo mkdir -p ./cloudbot-backup
sudo docker compose -f /opt/cloudbot/docker/compose.yaml --env-file /opt/cloudbot/.env stop hub
sudo docker ps -q --filter name=cloudbot-i- | xargs --no-run-if-empty sudo docker stop
sudo docker volume ls -q | grep -E '^(hub-data|cbi-)' | while IFS= read -r volume; do
  sudo docker run --rm \
    -v "$volume:/source:ro" \
    -v "$PWD/cloudbot-backup:/backup" \
    alpine:3.20 \
    tar -czf "/backup/$volume.tgz" -C /source .
done
sudo docker compose -f /opt/cloudbot/docker/compose.yaml --env-file /opt/cloudbot/.env start hub
```

Keep the archives somewhere outside the VPS too. Test restoring a backup before
you rely on it.

## Limits

The memory budget limits container memory, not disk use. CloudBot does not set
disk quotas. Monitor disk space and keep backups of all `hub-data` and `cbi-*`
volumes.
