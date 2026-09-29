#!/bin/sh
# Backup way out to the internet for the NAS, through aws1: an HTTP proxy on 127.0.0.1:1057 (http-socks.js, CONNECT
# only) in front of a SOCKS5 tunnel on 127.0.0.1:1058, traffic leaving from AWS. Used when the LAN proxy on the PC
# is down; nothing else on the NAS is routed through it.
#   - a second, unprivileged tailscaled (userspace, own state, node "huatan-balcony-egress", shields-up) gives this
#     NAS a way into the tailnet (the system Tailscale package has none, and Tailscale refuses exit nodes on Synology)
#   - ssh -N -D over that node to aws1's tailnet address; the key may only forward (restrict,port-forwarding on AWS),
#     the AWS host key is pinned in egress/known_hosts
#   egress.sh start|stop|restart|status     egress.sh login   (once: prints a URL to approve the new node)
# "start" runs at boot next to run.sh (DSM Task Scheduler, user huatanshaonian).
ROOT=$(cd "$(dirname "$0")" && pwd)
DIR=$ROOT/egress
BIN=/volume2/@appstore/Tailscale/bin
SOCK=$DIR/tailscaled.sock
SUP=$DIR/supervisor.pid
AWS=${AME_EGRESS_HOST:-ubuntu@100.120.53.46}
KEY=$HOME/.ssh/ame_egress
NODE=/var/packages/Node.js_v22/target/usr/local/bin/node
ts() { "$BIN/tailscale" --socket="$SOCK" "$@"; }

running() { [ -f "$SUP" ] && kill -0 "$(cat "$SUP")" 2>/dev/null; }

# run "$@" forever: restart 3 s after it exits, backing off to 60 s when it keeps dying right away
forever() {
  wait_s=3
  while :; do
    t0=$(date +%s)
    "$@"
    [ $(( $(date +%s) - t0 )) -gt 60 ] && wait_s=3
    sleep $wait_s
    wait_s=$(( wait_s * 2 )); [ $wait_s -gt 60 ] && wait_s=60
  done
}

tailscaled_run() {
  # keep only the first 200 lines of each run (tailscaled is chatty); no log upload to Tailscale
  "$BIN/tailscaled" --tun=userspace-networking --statedir="$DIR" --socket="$SOCK" --port=0 --no-logs-no-support 2>&1 \
    | sed -u '1,200p;201s,.*,[further logs suppressed],p;d' > "$DIR/tailscaled.log"
}

tunnel_run() {
  # /usr/bin first: Entware's busybox tools earlier in PATH lack options ssh-related tools expect
  PATH=/usr/bin:$PATH ssh -N -D 127.0.0.1:1058 -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes \
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$DIR/known_hosts" -o HostKeyAlgorithms=ssh-ed25519 \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -o ProxyCommand="$BIN/tailscale --socket=$SOCK nc %h %p" "$AWS" >> "$DIR/tunnel.log" 2>&1
  echo "$(date "+%F %T") tunnel closed ($?)" >> "$DIR/tunnel.log"
  [ "$(wc -c < "$DIR/tunnel.log")" -gt 200000 ] && mv "$DIR/tunnel.log" "$DIR/tunnel.log.old"
}

supervise() {
  forever tailscaled_run &
  forever "$NODE" "$ROOT/http-socks.js" &
  sleep 5
  forever tunnel_run
}

case "$1" in
  start)
    running && { echo "already running"; exit 0; }
    mkdir -p "$DIR" && chmod 700 "$DIR" && cd "$DIR" && umask 077
    setsid sh "$ROOT/$(basename "$0")" _supervise < /dev/null > /dev/null 2>&1 &
    echo $! > "$SUP"; echo "started" ;;
  _supervise) supervise ;;
  stop)
    running || { echo "not running"; exit 0; }
    pgid=$(ps -o pgid= -p "$(cat "$SUP")" | tr -d " ")
    kill -TERM -- "-$pgid" 2>/dev/null; rm -f "$SUP"; echo "stopped" ;;
  restart) "$0" stop; sleep 1; "$0" start ;;
  login)
    # shields-up: this node accepts no incoming connections; it only carries the NAS's outgoing traffic
    ts up --hostname=huatan-balcony-egress --shields-up --accept-dns=false --accept-routes=false && ts status ;;
  status)
    running && echo "running (supervisor $(cat "$SUP"))" || { echo "not running"; exit 1; }
    ts status --peers=false 2>&1 | head -2; tail -2 "$DIR/tunnel.log" 2>/dev/null ;;
  *) echo "usage: $0 start|stop|restart|status|login"; exit 1 ;;
esac
