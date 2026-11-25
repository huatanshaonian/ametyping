#!/bin/sh
# Ame dashboard server on the NAS.  run.sh start|stop|restart|status
# "start" is run once at boot (DSM Task Scheduler, triggered task "Boot-up", user huatanshaonian). It launches a small
# supervisor loop that restarts the server when it exits (3 s, backing off to 60 s when it keeps dying right away).
# Installed by hand as <NAS dir>/run.sh (deploy.js only calls it). The supervisors and servers are found by their command
# lines, not only through supervisor.pid: a supervisor the file did not record (2026-11-24: one left from an earlier
# start held port 8787, the new server kept dying with EADDRINUSE) is stopped too, and start never makes a second one.
ROOT=$(cd "$(dirname "$0")" && pwd)
SELF=$ROOT/$(basename "$0")      # this script by absolute path (it may have been started as "sh run.sh")
D=$ROOT/remote
NODE=/var/packages/Node.js_v22/target/usr/local/bin/node
SUP=$ROOT/supervisor.pid
LOG=$D/server/server.log

# pids of this directory's supervisor loops / servers (by command line; never this shell itself)
supervisors() { ps -eo pid=,args= | awk -v s="$SELF _supervise" -v me="$$" '$1 != me && index($0, s) && !index($0, "awk") { print $1 }'; }
servers() { ps -eo pid=,args= | awk -v s="$D/server/server.js" 'index($0, s) && !index($0, "awk") { print $1 }'; }
running() { [ -n "$(supervisors)" ]; }

supervise() {
  echo $$ > "$SUP"
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

stop() {
  sups=$(supervisors); srvs=$(servers)
  [ -z "$sups$srvs" ] && { rm -f "$SUP"; echo "not running"; return 0; }
  # each supervisor's whole process group (the loop and its server); then any server left outside them
  for p in $sups; do
    pg=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d " ")
    if [ -n "$pg" ]; then kill -TERM -- "-$pg" 2>/dev/null; else kill -TERM "$p" 2>/dev/null; fi
  done
  for p in $srvs; do kill -TERM "$p" 2>/dev/null; done
  # the server saves its data on SIGTERM: give it up to 15 s, then kill what is left
  i=0
  while [ $i -lt 15 ] && [ -n "$(supervisors)$(servers)" ]; do sleep 1; i=$((i + 1)); done
  left="$(supervisors) $(servers)"
  if [ -n "$(echo $left)" ]; then kill -KILL $left 2>/dev/null; sleep 1; echo "stopped (killed: $(echo $left))"; else echo "stopped"; fi
  rm -f "$SUP"
}

case "$1" in
  start)
    running && { echo "already running (supervisor $(supervisors | tr '\n' ' '))"; exit 0; }
    [ -f "$D/server/config.json" ] || { echo "no config.json yet (run setup.js init)"; exit 1; }
    [ -n "$(servers)" ] && { echo "a server of this directory is running without its supervisor: run.sh stop first"; exit 1; }
    cd "$D" && umask 077
    # setsid: the loop outlives the task scheduler / ssh session that started it (it writes supervisor.pid itself)
    setsid sh "$SELF" _supervise < /dev/null > /dev/null 2>&1 &
    sleep 1; echo "started" ;;
  _supervise) supervise ;;
  stop) stop ;;
  restart) stop; sleep 1; sh "$SELF" start ;;
  status)
    n=$(supervisors | wc -l | tr -d " ")
    if [ "$n" -gt 1 ]; then echo "running ($n supervisors: $(supervisors | tr '\n' ' ')-- run.sh restart)";
    elif [ "$n" -eq 1 ]; then echo "running (supervisor $(supervisors))"; else echo "not running"; fi ;;
  *) echo "usage: $0 start|stop|restart|status"; exit 1 ;;
esac
