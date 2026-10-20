#!/usr/bin/env bash
# Installs CloudBot on a fresh Debian or Ubuntu server, as root.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mateuscmtropical/cloudbot/main/docker/install.sh | sudo bash
#   curl -fsSL <same url> | sudo bash -s -- bot.example.com
#
# Without a domain, CloudBot uses <public-ip-with-dashes>.sslip.io over HTTPS.
#
# Environment:
#   CLOUDBOT_INSTALL_DIR  where the repository lives (default /opt/cloudbot)
#   CLOUDBOT_REPO_URL     repository to clone (default: the GitHub repository)
#   CLOUDBOT_SKIP_CLONE   set to 1 to use the folder as it is (CI uses this)

set -euo pipefail

INSTALL_DIR="${CLOUDBOT_INSTALL_DIR:-/opt/cloudbot}"
REPO_URL="${CLOUDBOT_REPO_URL:-https://github.com/mateuscmtropical/cloudbot.git}"
SKIP_CLONE="${CLOUDBOT_SKIP_CLONE:-0}"
COMMAND_PATH="/usr/local/bin/cloudbot"
HEALTH_ATTEMPTS=150
DOMAIN=""
CONTAINER_ID=""

# A fresh VM may run apt or unattended upgrades right after boot, so apt waits
# for the lock and does not stop to ask questions.
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

log() {
    echo "==> $1"
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

choose_domain() {
    if [ "$#" -ge 1 ]; then
        DOMAIN="$1"
    else
        local public_ip
        public_ip="$(curl -fsS https://api.ipify.org)"
        printf '%s' "$public_ip" | grep -Eq '^[0-9]+(\.[0-9]+){3}$' || fail "could not read the public IP address"
        DOMAIN="${public_ip//./-}.sslip.io"
    fi

    case "$DOMAIN" in
        "" | *[!A-Za-z0-9.-]*) fail "invalid domain '$DOMAIN'" ;;
    esac
    log "domain: $DOMAIN"
}

write_env_file() {
    (
        umask 077
        printf 'CLOUDBOT_DOMAIN=%s\n' "$DOMAIN" > "$INSTALL_DIR/.env"
    )
}

install_command() {
    # A symlink, so `cloudbot update` also updates the command itself.
    chmod 0755 "$INSTALL_DIR/docker/cloudbot"
    ln -sfn "$INSTALL_DIR/docker/cloudbot" "$COMMAND_PATH"
    log "installed the cloudbot command at $COMMAND_PATH"
}

start_cloudbot() {
    log "building and starting CloudBot (the first build takes a few minutes)"
    compose up -d --build

    CONTAINER_ID="$(compose ps -q cloudbot)"
    [ -n "$CONTAINER_ID" ] || fail "the cloudbot container did not start"

    local status
    for _attempt in $(seq "$HEALTH_ATTEMPTS"); do
        status="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER_ID")"
        if [ "$status" = "healthy" ]; then
            log "CloudBot is healthy"
            return 0
        fi
        sleep 2
    done

    fail "CloudBot did not become healthy. See: cloudbot logs"
}

print_setup_link() {
    # Only logs from this start of the container count. An older link in the
    # history is spent, so it must not be printed.
    local started_at
    local setup_link
    started_at="$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER_ID")"
    setup_link="$(compose logs --no-color --since "$started_at" cloudbot | grep -Eo 'https?://[^ ]*/setup[?]code=[^ ]*' | tail -n 1 || true)"

    echo ""
    if [ -n "$setup_link" ]; then
        echo "Open this link to make this browser the owner:"
        echo "  $setup_link"
    else
        echo "No setup link in the logs. The owner may already be set. Run: sudo cloudbot setup-link"
    fi
}

main() {
    require_root
    check_os
    install_base_packages
    install_docker
    fetch_repository
    choose_domain "$@"
    write_env_file
    install_command
    start_cloudbot
    print_setup_link
}

main "$@"