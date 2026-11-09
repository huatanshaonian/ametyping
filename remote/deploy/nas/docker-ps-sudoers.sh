#!/bin/sh
# Let the dashboard user run the Docker commands the infra probe needs without a password
# (remote/agent/infra-probe.js: findDocker/collectDocker -> "sudo -n docker ps -a --format ...",
#  executeControl -> "sudo -n docker start|stop|restart <name>").
# Nothing else is allowed (no run/exec/rm/pull), so this does not hand out general root via Docker.
# Run once as root:  sudo sh docker-ps-sudoers.sh        Undo:  sudo sh docker-ps-sudoers.sh remove
set -eu
U=huatanshaonian
DOCKER=/usr/local/bin/docker
F=/etc/sudoers.d/ame-docker-ps

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

if [ "${1:-}" = remove ]; then
  rm -f "$F"; echo "removed $F"; exit 0
fi

[ -x "$DOCKER" ] || { echo "$DOCKER not found"; exit 1; }
id "$U" >/dev/null 2>&1 || { echo "user $U not found"; exit 1; }

TMP=$(mktemp /etc/sudoers.d/.ame-docker-ps.XXXXXX)
printf '%s ALL=(root) NOPASSWD: %s ps -a --format *, %s start *, %s stop *, %s restart *\n' \
  "$U" "$DOCKER" "$DOCKER" "$DOCKER" "$DOCKER" > "$TMP"
chmod 0440 "$TMP"

# Syntax check before the file goes live (a broken sudoers.d file disables sudo for everyone).
if command -v visudo >/dev/null 2>&1; then
  visudo -cf "$TMP" >/dev/null || { rm -f "$TMP"; echo "syntax check failed, nothing changed"; exit 1; }
fi
mv "$TMP" "$F"

# DSM may not ship visudo: confirm sudo still parses its config; roll back if not (we are still root here).
if ! sudo -l -U "$U" >/dev/null 2>&1; then
  rm -f "$F"; echo "sudo rejected the new rule, rolled back"; exit 1
fi

echo "installed $F:"; cat "$F"
echo "check as $U:  sudo -n $DOCKER ps -a --format '{{.Names}}|{{.State}}'"
