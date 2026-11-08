#!/bin/sh
# AmeTyping Lightweight Infrastructure Probe (ame-probe.sh)
# Zero-dependency POSIX /bin/sh agent for AWS / GCP / Linux servers and OpenWrt routers.
# - Event-driven: checks local service states every 5s; only sends network packets when state changes or on heartbeat
#   (60s idle, 10s when dashboard window is open).
# - Supports <1s remote control (service restart/start/stop, docker restart, OpenWrt sing-box retest) via HTTP long-poll.

CONF="${AME_PROBE_CONF:-/etc/ame-probe/config.env}"
[ -f "$CONF" ] || CONF="$HOME/.ametyping/probe.env"
[ -f "$CONF" ] && . "$CONF"

SERVER="${AME_SERVER:-https://win98.huatan.org}"
SERVER="${SERVER%/}"
TOKEN="${AME_TOKEN:-}"
NAME="${AME_NAME:-$(cat /proc/sys/kernel/hostname 2>/dev/null || hostname)}"
ROLE="${AME_ROLE:-}"
if [ -z "$ROLE" ]; then
  if [ -f /etc/openwrt_release ]; then ROLE="router"; else ROLE="cloud"; fi
fi

ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

if [ "$ONCE" -eq 0 ] && [ -z "$TOKEN" ]; then
  echo "ame-probe: missing AME_TOKEN in $CONF" >&2
  exit 1
fi

TMP_DIR="/tmp/ame-probe-$$"
mkdir -p "$TMP_DIR"
chmod 700 "$TMP_DIR" 2>/dev/null || true
POLL_PID=""
trap 'trap - EXIT INT TERM; rm -rf "$TMP_DIR"; [ -n "$POLL_PID" ] && kill "$POLL_PID" 2>/dev/null || true; exit 0' EXIT INT TERM

INTERVAL_FILE="$TMP_DIR/interval"
WATCHED_FILE="$TMP_DIR/watched"
TARGETS_FILE="$TMP_DIR/targets"
FORCE_FILE="$TMP_DIR/force"
echo "60" > "$INTERVAL_FILE"
echo "" > "$WATCHED_FILE"
echo "" > "$TARGETS_FILE"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/ /g' | tr -d '\r\n'
}

# Sample CPU % delta over /proc/stat
PREV_IDLE=0
PREV_TOTAL=0
sample_cpu() {
  if [ ! -r /proc/stat ]; then echo 0; return; fi
  set -- $(sed -n '1p' /proc/stat)
  shift
  u=${1:-0}; n=${2:-0}; s=${3:-0}; id=${4:-0}; io=${5:-0}; ir=${6:-0}; si=${7:-0}; st=${8:-0}
  idle=$((id + io))
  total=$((u + n + s + id + io + ir + si + st))
  d_idle=$((idle - PREV_IDLE))
  d_total=$((total - PREV_TOTAL))
  PREV_IDLE=$idle
  PREV_TOTAL=$total
  if [ "$d_total" -le 0 ]; then echo 0; return; fi
  pct=$(( (d_total - d_idle) * 100 / d_total ))
  [ "$pct" -lt 0 ] && pct=0
  [ "$pct" -gt 100 ] && pct=100
  echo "$pct"
}
sample_cpu >/dev/null

# Sample network RX/TX bytes & KB/s from /proc/net/dev
PREV_NET_AT=0
PREV_RX=0
PREV_TX=0
sample_net() {
  now=$(date +%s)
  rx=0; tx=0
  if [ -r /proc/net/dev ]; then
    while IFS=: read -r iface rest; do
      iface=$(printf '%s' "$iface" | tr -d ' ')
      case "$iface" in
        ""|Inter*|face|lo|veth*|docker*|br-*|virbr*) continue ;;
      esac
      set -- $rest
      r1=${1:-0}; t1=${9:-0}
      rx=$((rx + r1))
      tx=$((tx + t1))
    done < /proc/net/dev
  fi
  rx_kbps=0; tx_kbps=0
  if [ "$PREV_NET_AT" -gt 0 ] && [ "$now" -gt "$PREV_NET_AT" ]; then
    dt=$((now - PREV_NET_AT))
    [ "$rx" -ge "$PREV_RX" ] && rx_kbps=$(( (rx - PREV_RX) / 1024 / dt ))
    [ "$tx" -ge "$PREV_TX" ] && tx_kbps=$(( (tx - PREV_TX) / 1024 / dt ))
  fi
  PREV_NET_AT=$now; PREV_RX=$rx; PREV_TX=$tx

  # Check vnstat monthly traffic if available
  m_rx=""; m_tx=""
  if command -v vnstat >/dev/null 2>&1; then
    vn=$(vnstat --json m 1 2>/dev/null)
    if [ -n "$vn" ]; then
      m_rx=$(printf '%s' "$vn" | sed -n 's/.*"month":\[{[^}]*"rx":\([0-9]*\).*/\1/p' | head -n 1)
      m_tx=$(printf '%s' "$vn" | sed -n 's/.*"month":\[{[^}]*"tx":\([0-9]*\).*/\1/p' | head -n 1)
    fi
  fi
  extra=""
  if [ -n "$m_rx" ] && [ -n "$m_tx" ]; then
    m_rx_gb=$(awk "BEGIN { printf \"%.2f\", $m_rx / 1073741824 }" 2>/dev/null || echo 0)
    m_tx_gb=$(awk "BEGIN { printf \"%.2f\", $m_tx / 1073741824 }" 2>/dev/null || echo 0)
    extra=",\"monthRxGb\":$m_rx_gb,\"monthTxGb\":$m_tx_gb"
  fi
  printf '{"rxBytes":%s,"txBytes":%s,"rxKbps":%s,"txKbps":%s%s}' "$rx" "$tx" "$rx_kbps" "$tx_kbps" "$extra"
}

collect_services_json() {
  watched=$(cat "$WATCHED_FILE" 2>/dev/null)
  out=""
  seen=" "

  add_svc() {
    s_name=$(json_escape "$1")
    s_label=$(json_escape "${2:-$1}")
    s_state="$3"
    s_kind="${4:-service}"
    s_port="${5:-0}"
    s_detail=$(json_escape "${6:-}")
    case "$seen" in *" $s_name "*) return ;; esac
    seen="$seen$s_name "
    item="{\"name\":\"$s_name\",\"label\":\"$s_label\",\"state\":\"$s_state\",\"kind\":\"$s_kind\""
    [ "$s_port" -gt 0 ] 2>/dev/null && item="$item,\"port\":$s_port"
    [ -n "$s_detail" ] && item="$item,\"detail\":\"$s_detail\""
    item="$item}"
    if [ -z "$out" ]; then out="$item"; else out="$out,$item"; fi
  }

  if [ -f /etc/openwrt_release ]; then
    # OpenWrt router discovery
    ps_out=$(ps w 2>/dev/null || ps 2>/dev/null)
    if printf '%s\n' "$ps_out" | grep -v grep | grep -q '/usr/bin/sing-box'; then
      add_svc "sing-box" "Sing-box 透明代理" "running" "init" 9090
    else
      add_svc "sing-box" "Sing-box 透明代理" "stopped" "init" 9090
    fi
    wd_cnt=$(printf '%s\n' "$ps_out" | grep -v grep | grep -c '/etc/sing-box/watchdog.sh' 2>/dev/null || echo 0)
    if [ "$wd_cnt" -gt 1 ]; then
      add_svc "singbox-watchdog" "Sing-box 断流自愈守护" "degraded" "script" 0 "${wd_cnt} 个重复实例运行中"
    elif [ "$wd_cnt" -eq 1 ]; then
      add_svc "singbox-watchdog" "Sing-box 断流自愈守护" "running" "script" 0
    else
      add_svc "singbox-watchdog" "Sing-box 断流自愈守护" "stopped" "script" 0
    fi
    if printf '%s\n' "$ps_out" | grep -v grep | grep -q 'tailscaled'; then
      add_svc "tailscaled" "Tailscale 路由节点" "running" "init" 0
    else
      add_svc "tailscaled" "Tailscale 路由节点" "stopped" "init" 0
    fi
    if printf '%s\n' "$ps_out" | grep -v grep | grep -q 'dnsmasq'; then
      add_svc "dnsmasq" "Dnsmasq (DHCP/DNS)" "running" "init" 53
    else
      add_svc "dnsmasq" "Dnsmasq (DHCP/DNS)" "stopped" "init" 53
    fi
  elif command -v systemctl >/dev/null 2>&1; then
    # Systemd Linux server discovery
    units=$(systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}' | sed 's/\.service$//')
    for u in $units; do
      case "$u" in
        systemd-*|dbus*|getty@*|serial-getty@*|multipathd|ModemManager|networkd-*|polkit|rsyslog|snapd*|udisks2|unattended-*|user@*|user-runtime-dir@*|accounts-daemon|cron|irqbalance|packagekit|acpid|chrony|fwupd*|blk-availability|console-setup|dmesg|finalrd|grub-*|keyboard-setup|lvm2-*|open-iscsi|pollinate|setvtrgb|ua-*|uuidd|vgauth|apport*|ec2-*|google-guest-*|google-osconfig-*|snap.amazon-ssm*|ssh|sshd)
          continue ;;
      esac
      port=0
      label="$u"
      case "$u" in
        danted) label="Dante SOCKS5 代理 (danted)"; port=1080 ;;
        claude-gcp-proxy) label="Claude HTTP 代理 (tinyproxy)"; port=18888 ;;
        frps) label="FRP 穿透服务端 (frps)"; port=7000 ;;
        rustdesk-hbbs) label="RustDesk ID 服务 (hbbs)"; port=21116 ;;
        rustdesk-hbbr) label="RustDesk 中继服务 (hbbr)"; port=21117 ;;
        nginx) label="Nginx Web/反代"; port=443 ;;
        tailscaled) label="Tailscale 节点服务" ;;
        vnstat) label="vnStat 流量统计" ;;
      esac
      add_svc "$u" "$label" "running" "systemd" "$port"
    done
    # Discover user-space listeners like magpie via ps
    ps_all=$(ps -ef 2>/dev/null)
    if printf '%s\n' "$ps_all" | grep -v grep | grep -q 'magpie serve'; then
      add_svc "magpie" "Magpie Web 服务 (:3430)" "running" "process" 3430
    fi
  fi

  # Ensure watched services are checked even if stopped
  for w in $watched; do
    case "$w" in docker:*) continue ;; esac
    case "$seen" in *" $w "*) continue ;; esac
    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$w.service" 2>/dev/null; then
      add_svc "$w" "$w" "running" "systemd" 0
    else
      add_svc "$w" "$w" "stopped" "systemd" 0
    fi
  done

  printf '[%s]' "$out"
}

collect_openwrt_proxy_json() {
  if [ ! -f /etc/sing-box/config.json ] || ! command -v ucode >/dev/null 2>&1; then
    printf 'null'
    return
  fi
  info=$(ucode -e '
    import * as fs from "fs";
    let c = json(fs.readfile("/etc/sing-box/config.json") || "{}");
    let addr = c?.experimental?.clash_api?.external_controller || "192.168.114.1:9090";
    let sec = c?.experimental?.clash_api?.secret || "";
    printf("%s|%s", addr, sec);
  ' 2>/dev/null)
  addr="${info%%|*}"
  sec="${info#*|}"
  [ -z "$addr" ] && { printf 'null'; return; }
  raw=$(curl -fsSL -m 2 -H "Authorization: Bearer $sec" "http://$addr/proxies" 2>/dev/null || wget --no-proxy --header="Authorization: Bearer $sec" -qO- -T 2 "http://$addr/proxies" 2>/dev/null)
  if [ -z "$raw" ]; then printf 'null'; return; fi
  printf '%s' "$raw" | ucode -e '
    import * as fs from "fs";
    let d = json(fs.stdin.read("all") || "{}");
    let p = d?.proxies || {};
    let grp = p["auto"]?.now || "";
    let real = (grp && p[grp]?.now) ? p[grp].now : grp;
    let hist = (real && p[real]?.history) ? p[real].history : [];
    let delay = length(hist) > 0 ? hist[length(hist) - 1]?.delay : null;
    printf("{\"group\":%J,\"active\":%J,\"delayMs\":%s}", grp || "auto", real || "", delay ? ("" + delay) : "null");
  ' 2>/dev/null || printf 'null'
}

collect_docker_json() {
  DOCKER=""
  if command -v docker >/dev/null 2>&1; then DOCKER="docker"
  elif [ -x /usr/local/bin/docker ]; then DOCKER="/usr/local/bin/docker"
  fi
  [ -z "$DOCKER" ] && { printf '[]'; return; }
  lines=$($DOCKER ps -a --format '{{.Names}}|{{.State}}|{{.Status}}|{{.Ports}}|{{.Image}}' 2>/dev/null || sudo -n $DOCKER ps -a --format '{{.Names}}|{{.State}}|{{.Status}}|{{.Ports}}|{{.Image}}' 2>/dev/null)
  [ -z "$lines" ] && { printf '[]'; return; }
  out=""
  IFS='
'
  for line in $lines; do
    n=$(printf '%s' "$line" | cut -d'|' -f1)
    st=$(printf '%s' "$line" | cut -d'|' -f2)
    status=$(printf '%s' "$line" | cut -d'|' -f3)
    ports=$(printf '%s' "$line" | cut -d'|' -f4)
    img=$(printf '%s' "$line" | cut -d'|' -f5)
    [ -z "$n" ] && continue
    state="stopped"
    [ "$st" = "running" ] && state="running"
    item="{\"name\":\"$(json_escape "$n")\",\"state\":\"$state\",\"status\":\"$(json_escape "$status")\",\"ports\":\"$(json_escape "$ports")\",\"image\":\"$(json_escape "$img")\"}"
    if [ -z "$out" ]; then out="$item"; else out="$out,$item"; fi
  done
  unset IFS
  printf '[%s]' "$out"
}

collect_links_json() {
  targets=$(cat "$TARGETS_FILE" 2>/dev/null)
  [ -z "$targets" ] && { printf '{}'; return; }
  out=""
  for entry in $targets; do
    lid=$(printf '%s' "$entry" | cut -d'|' -f1)
    lhost=$(printf '%s' "$entry" | cut -d'|' -f2)
    lport=$(printf '%s' "$entry" | cut -d'|' -f3)
    [ -z "$lid" ] || [ -z "$lhost" ] || [ -z "$lport" ] && continue
    ms_raw=$(curl -o /dev/null -s -m 2 -w '%{time_connect}' "http://$lhost:$lport" 2>/dev/null)
    rc=$?
    # curl exit 0, 52 (empty reply), 56 (reset after connect) all mean TCP connected!
    if [ "$rc" -eq 0 ] || [ "$rc" -eq 52 ] || [ "$rc" -eq 56 ]; then
      ms=$(awk "BEGIN { m = int(($ms_raw + 0) * 1000); if (m < 1) m = 1; print m }" 2>/dev/null || echo 15)
      item="\"$(json_escape "$lid")\":{\"ok\":true,\"ms\":$ms}"
    else
      item="\"$(json_escape "$lid")\":{\"ok\":false,\"err\":\"unreachable\"}"
    fi
    if [ -z "$out" ]; then out="$item"; else out="$out,$item"; fi
  done
  printf '{%s}' "$out"
}

build_report_json() {
  uptime_s=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0)
  load1=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)
  cpu_pct=$(sample_cpu)

  mem_total_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
  mem_avail_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null)
  if [ -z "$mem_avail_kb" ]; then
    mem_free_kb=$(awk '/^MemFree:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
    mem_buf_kb=$(awk '/^Buffers:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
    mem_cac_kb=$(awk '/^Cached:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
    mem_avail_kb=$((mem_free_kb + mem_buf_kb + mem_cac_kb))
  fi
  mem_total_mb=$((mem_total_kb / 1024))
  mem_used_mb=$(( (mem_total_kb - mem_avail_kb) / 1024 ))
  [ "$mem_used_mb" -lt 0 ] && mem_used_mb=0
  mem_pct=0
  [ "$mem_total_mb" -gt 0 ] && mem_pct=$((mem_used_mb * 100 / mem_total_mb))

  df_line=$(df -kP / 2>/dev/null | tail -n 1)
  disk_total_kb=$(printf '%s' "$df_line" | awk '{print $2}')
  disk_used_kb=$(printf '%s' "$df_line" | awk '{print $3}')
  disk_pct=$(printf '%s' "$df_line" | awk '{gsub(/%/,"",$5); print $5+0}')
  disk_total_gb=$(awk "BEGIN { printf \"%.1f\", ${disk_total_kb:-0} / 1048576 }" 2>/dev/null || echo 0)
  disk_used_gb=$(awk "BEGIN { printf \"%.1f\", ${disk_used_kb:-0} / 1048576 }" 2>/dev/null || echo 0)

  net_json=$(sample_net)
  svcs_json=$(collect_services_json)
  cnts_json=$(collect_docker_json)
  links_json=$(collect_links_json)
  proxy_json="null"
  [ -f /etc/openwrt_release ] && proxy_json=$(collect_openwrt_proxy_json)

  LAST_SIG="${svcs_json}|${cnts_json}"
  printf '{"uptimeSec":%s,"load1":%s,"cpuPct":%s,"mem":{"totalMb":%s,"usedMb":%s,"pct":%s},"disk":{"totalGb":%s,"usedGb":%s,"pct":%s,"mount":"/"},"net":%s,"services":%s,"containers":%s,"links":%s,"proxy":%s}' \
    "$uptime_s" "$load1" "$cpu_pct" \
    "$mem_total_mb" "$mem_used_mb" "$mem_pct" \
    "$disk_total_gb" "$disk_used_gb" "${disk_pct:-0}" \
    "$net_json" "$svcs_json" "$cnts_json" "$links_json" "$proxy_json"
}

execute_action() {
  rid="$1"; kind="$2"; target="$3"; op="$4"
  ok="false"; msg="不支持的操作"

  if [ "$kind" = "singbox" ] && [ "$op" = "retest" ] && [ -f /etc/sing-box/config.json ]; then
    info=$(ucode -e '
      import * as fs from "fs";
      let c = json(fs.readfile("/etc/sing-box/config.json") || "{}");
      printf("%s|%s", c?.experimental?.clash_api?.external_controller || "192.168.114.1:9090", c?.experimental?.clash_api?.secret || "");
    ' 2>/dev/null)
    addr="${info%%|*}"; sec="${info#*|}"
    for grp in auto-gold auto-silver auto-bronze auto; do
      curl -fsSL -m 5 -H "Authorization: Bearer $sec" "http://$addr/group/$grp/delay?url=https://www.gstatic.com/generate_204&timeout=3000" >/dev/null 2>&1 || true
    done
    ok="true"; msg="已完成 Sing-box 节点分级重测与切换"
  elif [ "$kind" = "service" ]; then
    if [ -f /etc/openwrt_release ] && [ -x "/etc/init.d/$target" ]; then
      if "/etc/init.d/$target" "$op" >/dev/null 2>&1; then
        ok="true"; msg="OpenWrt 服务 $target 已执行 $op"
      else
        msg="执行 /etc/init.d/$target $op 失败"
      fi
    elif command -v systemctl >/dev/null 2>&1; then
      if systemctl "$op" "$target.service" >/dev/null 2>&1 || sudo -n systemctl "$op" "$target.service" >/dev/null 2>&1; then
        ok="true"; msg="服务 $target 已执行 $op"
      else
        msg="systemctl $op $target 失败（需 sudo 免密或 root 权限）"
      fi
    fi
  elif [ "$kind" = "docker" ]; then
    if docker "$op" "$target" >/dev/null 2>&1 || sudo -n docker "$op" "$target" >/dev/null 2>&1; then
      ok="true"; msg="容器 $target 已执行 $op"
    else
      msg="docker $op $target 失败"
    fi
  fi

  rep=$(build_report_json)
  body="{\"rid\":\"$(json_escape "$rid")\",\"ok\":$ok,\"msg\":\"$(json_escape "$msg")\",\"report\":$rep}"
  curl -fsSL -m 10 -X POST "$SERVER/api/infra/control-result" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" >/dev/null 2>&1 || true
}

parse_server_response() {
  resp="$1"
  from_poll="${2:-}"
  [ -z "$resp" ] && return
  iv=$(printf '%s' "$resp" | sed -n 's/.*"intervalSec":\([0-9]*\).*/\1/p' | head -n 1)
  [ -n "$iv" ] && [ "$iv" -ge 5 ] 2>/dev/null && echo "$iv" > "$INTERVAL_FILE"

  if printf '%s' "$resp" | grep -q '"collectNow":true'; then
    echo 1 > "$FORCE_FILE"
    if [ "$from_poll" = "1" ]; then
      send_report >/dev/null 2>&1 || true
    fi
  fi

  # Extract single-action if present: {"kind":"...","target":"...","op":"...","rid":"..."}
  if printf '%s' "$resp" | grep -q '"rid":"ic_'; then
    rid=$(printf '%s' "$resp" | sed -n 's/.*"rid":"\(ic_[^"]*\)".*/\1/p' | head -n 1)
    kind=$(printf '%s' "$resp" | sed -n 's/.*"kind":"\([^"]*\)".*/\1/p' | head -n 1)
    target=$(printf '%s' "$resp" | sed -n 's/.*"target":"\([^"]*\)".*/\1/p' | head -n 1)
    op=$(printf '%s' "$resp" | sed -n 's/.*"op":"\([^"]*\)".*/\1/p' | head -n 1)
    if [ -n "$rid" ] && [ -n "$kind" ] && [ -n "$op" ]; then
      execute_action "$rid" "$kind" "$target" "$op"
    fi
  fi
}

send_report() {
  rep=$(build_report_json)
  payload="{\"role\":\"$(json_escape "$ROLE")\",\"report\":$rep}"
  resp=$(curl -fsSL --connect-timeout 6 -m 15 --retry 1 --retry-delay 2 -X POST "$SERVER/api/infra/report" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null) || return 1
  printf '%s' "$resp" | grep -q '"ok":true' || return 1
  parse_server_response "$resp" "0"
  return 0
}

if [ "$ONCE" -eq 1 ]; then
  rep=$(build_report_json)
  printf '{"role":"%s","report":%s}\n' "$(json_escape "$ROLE")" "$rep"
  exit 0
fi

# Background long-poll loop for instant (<1s) remote control & fast-mode wakeup
(
  while :; do
    resp=$(curl -fsSL --connect-timeout 6 -m 32 "$SERVER/api/infra/poll" -H "Authorization: Bearer $TOKEN" 2>/dev/null)
    if [ -n "$resp" ]; then
      parse_server_response "$resp" "1"
    else
      sleep 5
    fi
  done
) &
POLL_PID=$!

# Main event-driven + heartbeat loop
PREV_SIG=""
LAST_SENT_AT=0

while :; do
  now=$(date +%s)
  interval=$(cat "$INTERVAL_FILE" 2>/dev/null || echo 60)
  svcs=$(collect_services_json)
  cnts=$(collect_docker_json)
  cur_sig="${svcs}|${cnts}"

  force=0
  if [ -f "$FORCE_FILE" ]; then
    rm -f "$FORCE_FILE"
    force=1
  fi

  if [ "$force" -eq 1 ] || [ "$cur_sig" != "$PREV_SIG" ] || [ $((now - LAST_SENT_AT)) -ge "$interval" ]; then
    if send_report; then
      PREV_SIG="$cur_sig"
      LAST_SENT_AT=$(date +%s)
    else
      # On transient failure, retry after ~10s instead of waiting a full heartbeat cycle
      LAST_SENT_AT=$((now - interval + 10))
    fi
  fi
  sleep 15
done
