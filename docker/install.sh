#!/usr/bin/env bash
# Installs CloudBot on a fresh Debian or Ubuntu server, as root.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mateuscmtropical/cloudbot/main/docker/install.sh | sudo bash
#   curl -fsSL <same url> | sudo bash -s -- bot.example.com owner
#
# Without a domain, CloudBot uses <public-ip-with-dashes>.sslip.io over HTTPS.
#
# Environment:
#   CLOUDBOT_INSTALL_DIR  where the repository lives (default /opt/cloudbot)
#   CLOUDBOT_REPO_URL     repository to clone (default: the GitHub repository)
#   CLOUDBOT_SKIP_CLONE   set to 1 to use the folder as it is (CI uses this)
#   CLOUDBOT_INSTANCE_BUDGET_MB total memory budget (default 10240)
#   CLOUDBOT_INSTANCE_MEMORY_MB memory limit per person (default 2560)

set -euo pipefail

INSTALL_DIR="${CLOUDBOT_INSTALL_DIR:-/opt/cloudbot}"
REPO_URL="${CLOUDBOT_REPO_URL:-https://github.com/mateuscmtropical/cloudbot.git}"
SKIP_CLONE="${CLOUDBOT_SKIP_CLONE:-0}"
COMMAND_PATH="/usr/local/bin/cloudbot"
HEALTH_ATTEMPTS=150
DOMAIN=""
OWNER_NAME="owner"
PUBLIC_IP=""
HUB_CONTAINER_ID=""

# A fresh VM may run apt or unattended upgrades right after boot, so apt waits
# for the lock and does not stop to ask questions.
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

log() {
    echo "==> $1"
}

warn() {
    echo "warning: $1" >&2
}

fail() {
    echo "error: $1" >&2
    exit 1
}

compose() {
    docker compose -f "$INSTALL_DIR/docker/compose.yaml" --env-file "$INSTALL_DIR/.env" "$@"
}

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        fail "run as root, for example: curl -fsSL <url> | sudo bash"
    fi
}

check_os() {
    [ -r /etc/os-release ] || fail "cannot read /etc/os-release"
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}" in
        debian | ubuntu) log "system: ${PRETTY_NAME:-$ID}" ;;
        *) fail "unsupported system '${ID:-unknown}'. CloudBot installs on Debian and Ubuntu." ;;
    esac
}

install_base_packages() {
    log "installing git, curl and certificates"
    apt-get -o DPkg::Lock::Timeout=300 update
    apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends ca-certificates curl git
}

install_docker() {
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        log "docker and docker compose are already installed"
        return
    fi

    # Distro packages such as docker.io often have no compose plugin, so the
    # official script runs whenever either tool is missing.
    log "installing docker with the official convenience script"
    curl -fsSL https://get.docker.com | sh

    docker compose version >/dev/null 2>&1 || fail "docker compose is not available"
}

fetch_repository() {
    if [ "$SKIP_CLONE" = "1" ]; then
        log "using the existing folder $INSTALL_DIR"
    elif [ -d "$INSTALL_DIR/.git" ]; then
        log "updating $INSTALL_DIR"
        git -C "$INSTALL_DIR" pull --ff-only
    elif [ -e "$INSTALL_DIR" ]; then
        fail "$INSTALL_DIR exists but is not a CloudBot git checkout"
    else
        log "cloning $REPO_URL into $INSTALL_DIR"
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
    fi

    [ -f "$INSTALL_DIR/docker/compose.yaml" ] || fail "no docker/compose.yaml in $INSTALL_DIR"
}

read_public_ip() {
    PUBLIC_IP="$(curl -fsS --max-time 15 https://api.ipify.org)" || fail "could not read the public IP address"
    printf '%s' "$PUBLIC_IP" | grep -Eq '^[0-9]+(\.[0-9]+){3}$' || fail "could not read an IPv4 public IP address"
}

choose_domain() {
    if [ "$#" -gt 2 ]; then
        fail "usage: install.sh [domain] [owner-name]"
    fi

    OWNER_NAME="${2:-owner}"
    case "$OWNER_NAME" in
        "" | -* | *- | *[!a-z0-9-]*) fail "invalid owner name '$OWNER_NAME'. Use lowercase letters, numbers and internal hyphens." ;;
    esac
    [ "${#OWNER_NAME}" -le 63 ] || fail "owner name must be at most 63 characters"

    if [ -n "${1:-}" ]; then
        DOMAIN="$1"
    else
        read_public_ip
        DOMAIN="${PUBLIC_IP//./-}.sslip.io"
    fi

    case "$DOMAIN" in
        "" | *[!A-Za-z0-9.-]* | -* | *- | *.) fail "invalid domain '$DOMAIN'" ;;
    esac
    if [ "$DOMAIN" != localhost ] && [ -z "$PUBLIC_IP" ]; then
        read_public_ip
    fi
    log "domain: $DOMAIN"
    log "owner name: $OWNER_NAME"
}

check_dns_record() {
    local hostname="$1"
    if getent hosts "$hostname" | awk -v expected_ip="$PUBLIC_IP" '$1 == expected_ip { found = 1 } END { exit !found }'; then
        log "DNS for $hostname resolves to this server"
        return 0
    fi

    warn "$hostname does not resolve to this server's public IP ($PUBLIC_IP). Set its A record before expecting HTTPS certificates to work. The installer will continue."
}

check_dns() {
    if [ "$DOMAIN" = localhost ]; then
        log "localhost uses plain HTTP and skips public DNS checks"
        return
    fi

    local check_name
    check_name="check-$(od -An -N4 -tx4 /dev/urandom | tr -d ' \n').$DOMAIN"
    check_dns_record "$DOMAIN"
    check_dns_record "$check_name"
}

write_env_file() {
    local instance_budget_mb="${CLOUDBOT_INSTANCE_BUDGET_MB:-10240}"
    local instance_memory_mb="${CLOUDBOT_INSTANCE_MEMORY_MB:-2560}"
    local instance_cpus="${CLOUDBOT_INSTANCE_CPUS:-2}"
    local idle_minutes="${CLOUDBOT_IDLE_MINUTES:-5}"

    (
        umask 077
        {
            printf 'CLOUDBOT_DOMAIN=%s\n' "$DOMAIN"
            printf 'CLOUDBOT_OWNER_NAME=%s\n' "$OWNER_NAME"
            printf 'CLOUDBOT_INSTANCE_BUDGET_MB=%s\n' "$instance_budget_mb"
            printf 'CLOUDBOT_INSTANCE_MEMORY_MB=%s\n' "$instance_memory_mb"
            printf 'CLOUDBOT_INSTANCE_CPUS=%s\n' "$instance_cpus"
            printf 'CLOUDBOT_IDLE_MINUTES=%s\n' "$idle_minutes"
        } > "$INSTALL_DIR/.env"
    )
}

install_command() {
    chmod 0755 "$INSTALL_DIR/docker/cloudbot"
    ln -sfn "$INSTALL_DIR/docker/cloudbot" "$COMMAND_PATH"
    log "installed the cloudbot command at $COMMAND_PATH"
}

start_hub() {
    log "building and starting CloudBot (the first build takes a few minutes)"
    compose up -d --build

    HUB_CONTAINER_ID="$(compose ps -q hub)"
    [ -n "$HUB_CONTAINER_ID" ] || fail "the hub container did not start"

    local status
    for _attempt in $(seq "$HEALTH_ATTEMPTS"); do
        status="$(docker inspect --format '{{.State.Health.Status}}' "$HUB_CONTAINER_ID")"
        if [ "$status" = "healthy" ]; then
            log "the hub is healthy"
            return 0
        fi
        sleep 2
    done

    fail "the hub did not become healthy. See: cloudbot logs"
}

print_owner_access() {
    local scheme="https"

    if [ "$DOMAIN" = localhost ]; then
        scheme="http"
    fi

    echo ""
    echo "Owner address: ${scheme}://${OWNER_NAME}.${DOMAIN}"
    echo "On a new install, open it now to choose the owner password. The first person to open it becomes the owner."
}

main() {
    require_root
    check_os
    install_base_packages
    install_docker
    fetch_repository
    choose_domain "$@"
    check_dns
    write_env_file
    install_command
    start_hub
    print_owner_access
}

main "$@"
