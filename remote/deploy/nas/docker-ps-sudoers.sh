#!/bin/sh
# Let the dashboard user run the Docker commands the infra probe needs without a password
# (remote/agent/infra-probe.js: findDocker/collectDocker -> "sudo -n docker ps -a --format ...",
#  executeControl -> "sudo -n docker start|stop|restart <name>" and "sudo -n ame-docker-upgrade upgrade <name>").
# Nothing else is allowed (no run/exec/rm/pull/compose), so this does not hand out general root via Docker.
# The upgrade goes through ame-docker-upgrade (docker-upgrade.sh next to this file, installed root-owned): it upgrades
# only compose projects an admin registered, and refuses when their files changed since (see that script).
# Run once as root:  sudo sh docker-ps-sudoers.sh        Undo:  sudo sh docker-ps-sudoers.sh remove
# Run again after docker-upgrade.sh changes (it copies the script to /usr/local/bin).
set -eu
U=huatanshaonian
DOCKER=/usr/local/bin/docker
UPGRADE=/usr/local/bin/ame-docker-upgrade
F=/etc/sudoers.d/ame-docker-ps
HERE=$(dirname "$(readlink -f "$0")")

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

if [ "${1:-}" = remove ]; then
  rm -f "$F" "$UPGRADE"; echo "removed $F and $UPGRADE (registrations in /usr/local/etc/ame-docker-upgrade kept)"; exit 0
fi

[ -x "$DOCKER" ] || { echo "$DOCKER not found"; exit 1; }
id "$U" >/dev/null 2>&1 || { echo "user $U not found"; exit 1; }
[ -f "$HERE/docker-upgrade.sh" ] || { echo "$HERE/docker-upgrade.sh not found"; exit 1; }

# root-owned copy: the dashboard user must not be able to change what it runs as root
install -o root -g root -m 0755 "$HERE/docker-upgrade.sh" "$UPGRADE.tmp"
sed -i 's/\r$//' "$UPGRADE.tmp"
mv "$UPGRADE.tmp" "$UPGRADE"

TMP=$(mktemp /etc/sudoers.d/.ame-docker-ps.XXXXXX)
printf '%s ALL=(root) NOPASSWD: %s ps -a --format *, %s start *, %s stop *, %s restart *, %s upgrade *\n' \
  "$U" "$DOCKER" "$DOCKER" "$DOCKER" "$DOCKER" "$UPGRADE" > "$TMP"
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

echo "installed $UPGRADE and $F:"; cat "$F"
echo "check as $U:  sudo -n $DOCKER ps -a --format '{{.Names}}|{{.State}}'"
echo "register each compose project once:  sudo $UPGRADE register /volume2/docker/<name>"
