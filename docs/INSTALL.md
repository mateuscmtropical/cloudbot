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
check. It prints the owner's address. It also installs
the `cloudbot` command in `/usr/local/bin`.

The owner address is `https://owner.example.com`. Open it right after the install.
The first person to open it chooses a password and becomes the owner. Nobody
can sign in before that, and the page closes as soon as the owner exists. Then connect an AI
provider in the chat.

The special domain `localhost` is for local checks. It uses plain HTTP at
`http://owner.localhost` and does not request a public certificate.

## Install on Windows

CloudBot runs on Linux, so on Windows it runs inside WSL 2. This works on
Windows 10 and 11, on x64 and on ARM. WSL picks the Ubuntu build for the
processor.

The installer is a PowerShell script. Open PowerShell as administrator and run:

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/mateuscmtropical/cloudbot/main/docker/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -OwnerName maria
```

The script installs the Ubuntu distro when it is missing, turns on systemd,
and runs `install.sh` with the `localhost` domain. Windows may ask for a
restart after it installs WSL. Run the script again after the restart. At the
end it prints the owner address.

Without the script, do the same by hand. Run `wsl --install -d Ubuntu` in an
administrator PowerShell, open Ubuntu, and run:

```sh
curl -fsSL https://raw.githubusercontent.com/mateuscmtropical/cloudbot/main/docker/install.sh | sudo bash -s -- localhost owner
```

Then open `http://owner.localhost` in your Windows browser and choose the
password of the owner.

What to expect:

- CloudBot runs only while WSL runs. If Windows or WSL shuts down, the
  instances stop. Open Ubuntu again and run `sudo cloudbot status`.
- The address works on this computer only. For a server other people can
  reach, use a VPS with a domain, as above.
- WSL limits its memory to half of the computer's RAM by default. The default
  of 2560 MB for each person fits, but a computer with 8 GB of RAM fits one or
  two people.
- Run every `cloudbot` command inside Ubuntu, not in PowerShell. From PowerShell,
  use `wsl -d Ubuntu -u root -- cloudbot status`.

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

To limit hub sign-in, set this variable in `/opt/cloudbot/.env` and run
`sudo cloudbot update`:

| Variable | Default | Description |
|---|---|---|
| `CLOUDBOT_LOGIN_ALLOWED_IPS` | Empty | Comma-separated IPv4 or IPv6 addresses and CIDR ranges. Keep the hub behind Caddy so the client address can be trusted. This limits sign-in only. It does not limit access to the rest of the site. |

The hub hibernates an idle instance after five minutes by default. An active
turn, a program a person started that listens on a port, or another activity that needs the instance keeps it awake. A later visit
starts a hibernated instance again.

## Commands and updates

| Command | What it does |
|---|---|
| `sudo cloudbot status` | Shows the hub, Docker socket proxy, Caddy, instances and instance memory use |
| `sudo cloudbot logs` | Follows hub logs. Press Ctrl+C to stop. |
| `sudo cloudbot update [--all]` | Pulls code and service images, rebuilds the CloudBot image and recreates the hub. `--all` also removes every instance container that uses an old image. |
| `sudo cloudbot reset-password [name]` | Prints a new one-time password. The default name is `owner`. |
| `sudo cloudbot uninstall [--keep-data] [--yes]` | Asks you to type `uninstall`, then removes the containers, networks, image, volumes and `/opt/cloudbot`. `--keep-data` keeps the volumes and the folder. `--yes` skips the question. Docker stays installed. |

After an update, instances that are already running continue on their existing
image. To move everyone to the new image, run the update with `--all`:

```sh
sudo cloudbot update --all
```

The update also removes images that no tag points to and build cache older than
three days. An old image stays while an instance still runs on it, so it goes
after the next `--all`.

To move one person only, remove that container:

```sh
sudo docker rm -f cloudbot-i-maria
```

The `cbi-*` volumes stay in place. The hub creates each container from the new
image on the person's next request.

### Image size

A new Docker 29 install keeps images in the containerd store, and then
`sudo docker image ls` shows two numbers for `cloudbot:local`. `CONTENT SIZE` is the compressed image, which
is what a pull downloads. `DISK USAGE` is the compressed image plus its unpacked
files, which is what the image takes on the disk. `docker image inspect` is not
a safe number to compare, since it shows one or the other depending on the
Docker version. The unpacked size alone is the sum of the layer sizes in `sudo docker history cloudbot:local`.
Compare `DISK USAGE` with the free space, and compare like with like when you
compare two images. Every instance shares the one image, so more people do not
add image space.

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
