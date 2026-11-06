#!/bin/sh
# AmeTyping 轻量监控探针一键安装脚本（支持 Ubuntu/Debian 云服务器 AWS/GCP 与 OpenWrt 软路由）
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/huatanshaonian/ametyping/main/install/install-infra.sh | \
#     AME_NAME='aws1' AME_TOKEN='粘贴令牌' sh
set -eu

RAW="${AME_RAW:-https://raw.githubusercontent.com/huatanshaonian/ametyping/main/install}"
SERVER="${AME_SERVER:-}"
NAME="${AME_NAME:-$(cat /proc/sys/kernel/hostname 2>/dev/null || hostname)}"
TOKEN="${AME_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  echo "错误：请提供 AME_TOKEN 环境变量（从 Windose 控制面板 → 电脑 生成）" >&2
  exit 1
fi

# Auto-pick best server URL if not explicitly set:
# 1. LAN NAS (192.168.114.6:8787) for OpenWrt / LAN hosts
# 2. Tailscale NAS (100.65.10.90:8788) if Tailscale is reachable
# 3. Public HTTPS (https://win98.huatan.org)
if [ -z "$SERVER" ]; then
  if [ -f /etc/openwrt_release ]; then
    SERVER="http://192.168.114.6:8787"
  elif curl -fsSL -m 3 "http://100.65.10.90:8788/api/infra/poll" -H "Authorization: Bearer $TOKEN" -m 1 >/dev/null 2>&1; then
    SERVER="http://100.65.10.90:8788"
  else
    SERVER="https://win98.huatan.org"
  fi
fi

ROLE="${AME_ROLE:-}"
if [ -z "$ROLE" ]; then
  if [ -f /etc/openwrt_release ]; then ROLE="router"; else ROLE="cloud"; fi
fi

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

$SUDO mkdir -p /etc/ame-probe
$SUDO chmod 700 /etc/ame-probe

TMP_CONF="/tmp/ame-probe-conf.$$"
cat > "$TMP_CONF" <<EOF
AME_SERVER='$SERVER'
AME_NAME='$NAME'
AME_TOKEN='$TOKEN'
AME_ROLE='$ROLE'
EOF
$SUDO mv "$TMP_CONF" /etc/ame-probe/config.env
$SUDO chmod 600 /etc/ame-probe/config.env

HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
BIN_DEST="/usr/local/bin/ame-probe.sh"
[ -f /etc/openwrt_release ] && BIN_DEST="/usr/bin/ame-probe.sh"
$SUDO mkdir -p "$(dirname "$BIN_DEST")"

if [ -n "$HERE" ] && [ -f "$HERE/ame-probe.sh" ]; then
  $SUDO cp "$HERE/ame-probe.sh" "$BIN_DEST"
else
  curl -fsSL "$RAW/ame-probe.sh" -o "/tmp/ame-probe.$$"
  $SUDO mv "/tmp/ame-probe.$$" "$BIN_DEST"
fi
$SUDO chmod 755 "$BIN_DEST"

if [ -f /etc/openwrt_release ]; then
  INIT_SCRIPT="/etc/init.d/ame-probe"
  cat > "/tmp/ame-probe-init.$$" <<EOF
#!/bin/sh /etc/rc.common
START=99
STOP=10
USE_PROCD=1

start_service() {
  procd_open_instance
  procd_set_param command /bin/sh "$BIN_DEST"
  procd_set_param respawn 3600 5 0
  procd_set_param stdout 1
  procd_set_param stderr 1
  procd_close_instance
}
EOF
  $SUDO mv "/tmp/ame-probe-init.$$" "$INIT_SCRIPT"
  $SUDO chmod 755 "$INIT_SCRIPT"
  $SUDO "$INIT_SCRIPT" enable
  $SUDO "$INIT_SCRIPT" restart
  echo "已安装并启动 OpenWrt 监控探针服务 (/etc/init.d/ame-probe) -> $SERVER"
elif command -v systemctl >/dev/null 2>&1; then
  UNIT="/etc/systemd/system/ame-probe.service"
  cat > "/tmp/ame-probe-unit.$$" <<EOF
[Unit]
Description=AmeTyping Lightweight Infrastructure Probe ($NAME)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/ame-probe/config.env
ExecStart=/bin/sh $BIN_DEST
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  $SUDO mv "/tmp/ame-probe-unit.$$" "$UNIT"
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now ame-probe.service
  $SUDO systemctl restart ame-probe.service
  echo "已安装并启动 systemd 监控探针服务 (ame-probe.service) -> $SERVER"
else
  echo "未检测到 systemd 或 procd，请手动在后台运行 $BIN_DEST"
fi
