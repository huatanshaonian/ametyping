#!/bin/sh
# Ame dashboard server on the NAS.  run.sh start|stop|restart|status
# "start" is run once at boot (DSM Task Scheduler, triggered task "Boot-up", user huatanshaonian). It launches a small
# supervisor loop that restarts the server when it exits (3 s, backing off to 60 s when it keeps dying right away).
ROOT=$(cd "$(dirname "$0")" && pwd)
D=$ROOT/remote
NODE=/var/packages/Node.js_v22/target/usr/local/bin/node
SUP=$ROOT/supervisor.pid
LOG=$D/server/server.log

running() { [ -f "$SUP" ] && kill -0 "$(cat "$SUP")" 2>/dev/null; }

supervise() {
  wait_s=3
  while :; do
    [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1000000 ] && mv "$LOG" "$LOG.old"
    t0=$(date +%s)
    "$NODE" "$D/server/server.js" >> "$LOG" 2>&1
    code=$?
    [ $(( $(date +%s) - t0 )) -gt 60 ] && wait_s=3        # it had been up for a while: normal quick restart
    echo "$(date "+%F %T") server exited ($code), restarting in ${wait_s}s" >> "$LOG"
    sleep $wait_s
    wait_s=$(( wait_s * 2 )); [ $wait_s -gt 60 ] && wait_s=60
  done
}

case "$1" in
  start)
    running && { echo "already running"; exit 0; }
    [ -f "$D/server/config.json" ] || { echo "no config.json yet (run setup.js init)"; exit 1; }
    cd "$D" && umask 077
    # setsid: the loop outlives the task scheduler / ssh session that started it
    setsid sh "$0" _supervise < /dev/null > /dev/null 2>&1 &
    echo $! > "$SUP"; echo "started" ;;
  _supervise) supervise ;;
  stop)
    running || { echo "not running"; exit 0; }
    pgid=$(ps -o pgid= -p "$(cat "$SUP")" | tr -d " ")
    kill -TERM -- "-$pgid" 2>/dev/null; rm -f "$SUP"; echo "stopped" ;;
  restart) "$0" stop; sleep 1; "$0" start ;;
  status) running && echo "running (supervisor $(cat "$SUP"))" || echo "not running" ;;
  *) echo "usage: $0 start|stop|restart|status"; exit 1 ;;
esac
