#!/usr/bin/env bash
# Checks a running CloudBot container: the health route answers, the container
# reports healthy, and the bot user cannot read the data folder.
#
# Usage: docker/check-container.sh <container-name> <host-port> [hub-container-name]

set -euo pipefail

CONTAINER_NAME="${1:?usage: check-container.sh <container-name> <host-port> [hub-container-name]}"
HOST_PORT="${2:?usage: check-container.sh <container-name> <host-port> [hub-container-name]}"
HUB_CONTAINER_NAME="${3:-}"
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

# The bot builds spreadsheets, documents, PDFs, slides and charts with these libraries.
docker exec --user bot "$CONTAINER_NAME" python3 -c "import docx, matplotlib, openpyxl, pptx, pypdf, reportlab" \
    || fail "bot cannot import the document libraries"
docker exec --user bot "$CONTAINER_NAME" pdftotext -v > /dev/null 2>&1 \
    || fail "bot cannot run pdftotext"
echo "ok: bot can use the document libraries and pdftotext"

CLAUDE_PATH="$(docker exec "$CONTAINER_NAME" printenv CLAUDE_PATH)"
AGENT_USER="$(docker exec "$CONTAINER_NAME" printenv CLOUDBOT_AGENT_USER)"
[ "$AGENT_USER" = "bot" ] || fail "CLOUDBOT_AGENT_USER must be bot"
docker exec --user cloudbot "$CONTAINER_NAME" sudo -n -u bot -- "$CLAUDE_PATH" --version \
    || fail "cloudbot cannot run the CLI as bot"
echo "ok: cloudbot can run the CLI as bot"

if SHELL_OUTPUT="$(docker exec --user cloudbot "$CONTAINER_NAME" sudo -n -u bot -- /bin/sh -c 'exit 0' 2>&1)"; then
    fail "cloudbot can run a shell as bot"
fi
case "$SHELL_OUTPUT" in
    *"not allowed"*|*"a password is required"*) ;;
    *) fail "unexpected sudo shell error: $SHELL_OUTPUT" ;;
esac
if ROOT_OUTPUT="$(docker exec --user cloudbot "$CONTAINER_NAME" sudo -n id 2>&1)"; then
    fail "cloudbot can run id as root"
fi
case "$ROOT_OUTPUT" in
    *"not allowed"*|*"a password is required"*) ;;
    *) fail "unexpected sudo root error: $ROOT_OUTPUT" ;;
esac
echo "ok: sudo denies a shell as bot and id as root"

docker exec --user cloudbot "$CONTAINER_NAME" mkdir -m 0770 /var/lib/cloudbot-workspaces/probe-workspace \
    || fail "cloudbot cannot create a workspace"
docker exec --user cloudbot "$CONTAINER_NAME" chmod 0770 /var/lib/cloudbot-workspaces/probe-workspace \
    || fail "cloudbot cannot set workspace permissions"
docker exec --user bot "$CONTAINER_NAME" sh -c 'printf own > /var/lib/cloudbot-workspaces/probe-workspace/control.txt' \
    || fail "bot cannot write to a server-created workspace"
docker exec --user bot "$CONTAINER_NAME" rm /var/lib/cloudbot-workspaces/probe-workspace/control.txt
docker exec --user cloudbot "$CONTAINER_NAME" rmdir /var/lib/cloudbot-workspaces/probe-workspace
echo "ok: bot can write to a server-created workspace"

# Uploads are read-only for the bot. It reads a file the server wrote, but it cannot add, rename or replace anything.
UPLOAD_PROBE="/var/lib/cloudbot-uploads/probe-upload"
docker exec --user cloudbot "$CONTAINER_NAME" sh -c "mkdir -m 2750 '$UPLOAD_PROBE' && printf upload > '$UPLOAD_PROBE/file.png' && chmod 0640 '$UPLOAD_PROBE/file.png'" \
    || fail "cloudbot cannot write an upload"
docker exec --user bot "$CONTAINER_NAME" cat "$UPLOAD_PROBE/file.png" > /dev/null \
    || fail "bot cannot read an upload"
if docker exec --user bot "$CONTAINER_NAME" sh -c "printf x > '$UPLOAD_PROBE/new.txt'" > /dev/null 2>&1; then
    fail "bot can create a file in an upload folder"
fi
if docker exec --user bot "$CONTAINER_NAME" mv "$UPLOAD_PROBE/file.png" "$UPLOAD_PROBE/moved.png" > /dev/null 2>&1; then
    fail "bot can rename an upload"
fi
if docker exec --user bot "$CONTAINER_NAME" sh -c "printf x > /var/lib/cloudbot-uploads/new.txt" > /dev/null 2>&1; then
    fail "bot can create a file in the upload root"
fi
docker exec --user cloudbot "$CONTAINER_NAME" rm -rf "$UPLOAD_PROBE"
echo "ok: bot can read uploads and cannot create, rename or replace files in them"

# The server starts the desktop as bot. Chromium answers on its DevTools port, on localhost only.
DESKTOP_READY=""
for _attempt in $(seq "$ATTEMPTS"); do
    if docker exec --user cloudbot "$CONTAINER_NAME" curl -fsS http://127.0.0.1:9222/json/version 2>/dev/null | grep -q '"Browser"'; then
        DESKTOP_READY="yes"
        break
    fi
    sleep 1
done
[ -n "$DESKTOP_READY" ] || fail "Chromium did not answer on the DevTools port"
docker exec "$CONTAINER_NAME" test -S /tmp/.X11-unix/X1 || fail "the virtual screen is missing"
CHROMIUM_USER="$(docker exec "$CONTAINER_NAME" ps -o user= -C chromium | sort -u)"
[ "$CHROMIUM_USER" = "bot" ] || fail "Chromium runs as '$CHROMIUM_USER', expected 'bot'"
echo "ok: the desktop runs as bot and Chromium answers on localhost"

if ARGUMENT_OUTPUT="$(docker exec --user cloudbot "$CONTAINER_NAME" sudo -n -u bot -- /usr/local/bin/cloudbot-desktop --extra 2>&1)"; then
    fail "cloudbot can pass arguments to the desktop script"
fi
case "$ARGUMENT_OUTPUT" in
    *"not allowed"*|*"a password is required"*) ;;
    *) fail "unexpected sudo desktop argument error: $ARGUMENT_OUTPUT" ;;
esac
echo "ok: sudo denies arguments to the desktop script"

# A process that left the turn's group with setsid still carries the turn marker, and the helper ends it (#165).
TURN_MARKER="0123456789abcdef0123456789abcdef"
# The desktop runs its own short sleeps as bot, so the test process is matched by its exact, unusual command line.
docker exec --user bot --env "CLOUDBOT_TURN_MARKER=$TURN_MARKER" "$CONTAINER_NAME" sh -c 'setsid sleep 3171 >/dev/null 2>&1 < /dev/null &'
sleep 1
docker exec --user bot "$CONTAINER_NAME" pgrep -u bot -f '^sleep 3171$' >/dev/null || fail "the marked test process did not start"
docker exec --user cloudbot "$CONTAINER_NAME" sudo -n -u bot -- /usr/local/bin/cloudbot-end-turn "$TURN_MARKER" || fail "the end-turn helper failed"
sleep 1
if docker exec --user bot "$CONTAINER_NAME" pgrep -u bot -f '^sleep 3171$' >/dev/null; then
    fail "a marked process outlived the end-turn helper"
fi
if docker exec --user cloudbot "$CONTAINER_NAME" sudo -n -u bot -- /usr/local/bin/cloudbot-end-turn "not-a-marker" 2>/dev/null; then
    fail "the end-turn helper accepted a bad marker"
fi
echo "ok: the end-turn helper ends a marked process that left the group, and refuses a bad marker"

docker exec --user cloudbot "$CONTAINER_NAME" rm -f "$PROBE_FILE"
if [ -n "$HUB_CONTAINER_NAME" ]; then
    HUB_HEALTH="$(docker inspect --format '{{.State.Health.Status}}' "$HUB_CONTAINER_NAME")"
    [ "$HUB_HEALTH" = "healthy" ] || fail "hub reports '$HUB_HEALTH', expected healthy"
    echo "ok: hub reports healthy"

    HUB_DATA_OWNER_AND_MODE="$(docker exec "$HUB_CONTAINER_NAME" stat -c '%U %a' /var/lib/cloudbot-hub)"
    [ "$HUB_DATA_OWNER_AND_MODE" = "cloudbot 700" ] || fail "/var/lib/cloudbot-hub is '$HUB_DATA_OWNER_AND_MODE', expected 'cloudbot 700'"
    echo "ok: cloudbot owns the private hub data folder"

    PROXY_URL="http://docker-proxy:2375"
    CONTAINER_LIST_STATUS="$(docker exec "$HUB_CONTAINER_NAME" curl -sS -o /dev/null -w '%{http_code}' "$PROXY_URL/containers/json")"
    [ "$CONTAINER_LIST_STATUS" = "200" ] || fail "container list returned HTTP $CONTAINER_LIST_STATUS through the socket proxy"
    echo "ok: the socket proxy allows a container list"

    for PROXY_PATH in /images/json /info; do
        PROXY_STATUS="$(docker exec "$HUB_CONTAINER_NAME" curl -sS -o /dev/null -w '%{http_code}' "$PROXY_URL$PROXY_PATH")"
        [ "$PROXY_STATUS" = "403" ] || fail "$PROXY_PATH returned HTTP $PROXY_STATUS through the socket proxy, expected 403"
    done

    EXEC_STATUS="$(docker exec "$HUB_CONTAINER_NAME" curl -sS -o /dev/null -w '%{http_code}' -X POST "$PROXY_URL/exec/x/start")"
    [ "$EXEC_STATUS" = "403" ] || fail "starting an exec returned HTTP $EXEC_STATUS through the socket proxy, expected 403"
    echo "ok: the socket proxy refuses image, info and exec start requests"
fi
echo "All container checks passed."
