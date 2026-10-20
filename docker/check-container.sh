#!/usr/bin/env bash
# Checks a running CloudBot container: the health route answers, the container
# reports healthy, and the bot user cannot read the data folder.
#
# Usage: docker/check-container.sh <container-name> <host-port>

set -euo pipefail

CONTAINER_NAME="${1:?usage: check-container.sh <container-name> <host-port>}"
HOST_PORT="${2:?usage: check-container.sh <container-name> <host-port>}"
DATA_DIR="/var/lib/cloudbot"
PROBE_FILE="$DATA_DIR/probe.txt"
ATTEMPTS=60

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

wait_for_health_route() {
    for _attempt in $(seq "$ATTEMPTS"); do
        if curl -fsS "http://127.0.0.1:$HOST_PORT/api/health" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

wait_for_healthy_status() {
    for _attempt in $(seq "$ATTEMPTS"); do
        local status
        status="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER_NAME")"
        if [ "$status" = "healthy" ]; then
            return 0
        fi
        sleep 1
    done
    return 1
}

wait_for_health_route || fail "/api/health did not answer on port $HOST_PORT"
echo "ok: /api/health answers"

wait_for_healthy_status || fail "container never reported healthy"
echo "ok: container reports healthy"

# The server user writes a probe file, the same way it would write the vault.
docker exec --user cloudbot "$CONTAINER_NAME" sh -c "printf probe > '$PROBE_FILE' && chmod 600 '$PROBE_FILE'" \
    || fail "server user cannot write to $DATA_DIR"

DATA_OWNER_AND_MODE="$(docker exec "$CONTAINER_NAME" stat -c '%U %a' "$DATA_DIR")"
[ "$DATA_OWNER_AND_MODE" = "cloudbot 700" ] || fail "$DATA_DIR is '$DATA_OWNER_AND_MODE', expected 'cloudbot 700'"
echo "ok: $DATA_DIR is owned by cloudbot with mode 700"

# Positive control first. Without it, a missing bot user or a stopped container
# would also look like a denied read.
BOT_IDENTITY="$(docker exec --user bot "$CONTAINER_NAME" id -un)"
[ "$BOT_IDENTITY" = "bot" ] || fail "exec as bot ran as '$BOT_IDENTITY'"
CONTROL_OUTPUT="$(docker exec --user bot "$CONTAINER_NAME" sh -c 'printf own > /home/bot/control.txt && cat /home/bot/control.txt')"
docker exec --user bot "$CONTAINER_NAME" rm -f /home/bot/control.txt
[ "$CONTROL_OUTPUT" = "own" ] || fail "bot cannot read its own home folder"
echo "ok: bot runs as bot and reads its own home folder"

# A denied read must say 'Permission denied'. Any other error fails the check.
if READ_OUTPUT="$(docker exec --user bot "$CONTAINER_NAME" cat "$PROBE_FILE" 2>&1)"; then
    fail "bot user can read $PROBE_FILE"
fi
case "$READ_OUTPUT" in
    *"Permission denied"*) ;;
    *) fail "unexpected error reading the probe file: $READ_OUTPUT" ;;
esac

if LIST_OUTPUT="$(docker exec --user bot "$CONTAINER_NAME" ls "$DATA_DIR" 2>&1)"; then
    fail "bot user can list $DATA_DIR"
fi
case "$LIST_OUTPUT" in
    *"Permission denied"*) ;;
    *) fail "unexpected error listing the data folder: $LIST_OUTPUT" ;;
esac
echo "ok: bot user cannot read or list the data folder"

docker exec --user cloudbot "$CONTAINER_NAME" rm -f "$PROBE_FILE"
echo "All container checks passed."