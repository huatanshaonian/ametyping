#!/usr/bin/env bash
# AmeTyping 一键安装（Linux）：无头服务（代替糖糖）+ 看板 agent + Claude Code hooks + systemd 用户服务
#
# 运行（任选其一）：
#   curl -fsSL https://raw.githubusercontent.com/huatanshaonian/ametyping/main/install/install-linux.sh | bash
#   bash install/install-linux.sh                      （在已克隆的仓库里）
#
# 需要：Node.js 18+（nvm 装的也行）、git、tmux（从看板回复要求 claude 跑在 tmux 里），这台机器已加入 Tailscale。
# 令牌在群晖上生成（脚本会给出命令），粘贴进来时不显示；可以重复运行（已有配置可保留）。
# 环境变量可改默认值：AME_DIR（安装目录，默认 ~/ametyping）、AME_BRANCH、AME_SERVER。
# 无人值守：设了下面这些就不再提问——AME_KEEP（保留已有 agent.json，y/n）、AME_NAME、AME_TOKEN、
#   AME_CONTROL（y/n）、AME_FILES（home / 文件夹逗号分隔 / none）、AME_LAUNCH（启动前命令，空=跳过）、AME_LINGER（y/n）。
set -euo pipefail
REPO=https://github.com/huatanshaonian/ametyping.git
DIR=${AME_DIR:-$HOME/ametyping}
BRANCH=${AME_BRANCH:-main}
SERVER=${AME_SERVER:-ws://100.65.10.90:8788/agent}

step() { printf '\n\033[35m== %s\033[0m\n' "$1"; }
info() { printf '   %s\n' "$1"; }
warn() { printf '   \033[33m! %s\033[0m\n' "$1"; }
# questions come from the terminal even when the script itself arrives through a pipe
# (a third argument names an environment variable that answers instead, for unattended installs)
ask() {
  if [ -n "${3:-}" ] && [ -n "${!3+x}" ]; then printf '%s' "${!3}"; return; fi
  local a=''; { read -r -p "   $1${2:+ [$2]}: " a </dev/tty; } 2>/dev/null || true   # no terminal: the default
  printf '%s' "${a:-${2:-}}"
}
yes() { [[ "$(ask "$1 (y/n)" "${2:-y}" "${3:-}")" =~ ^[yY] ]]; }

# ---------------------------------------------------------------------------------------------------------------
step '检查环境'
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi
command -v node >/dev/null 2>&1 || { warn '没找到 Node.js：请先安装 18 以上版本（例如 nvm install --lts）再运行'; exit 1; }
NODE=$(readlink -f "$(command -v node)")
NPM="$(dirname "$NODE")/npm"; [ -x "$NPM" ] || NPM=$(command -v npm)
[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 18 ] || { warn "Node.js 版本太旧（$("$NODE" -v)），需要 18 以上"; exit 1; }
info "Node.js $("$NODE" -v)：$NODE"
command -v git >/dev/null 2>&1 || { warn '没找到 git，请先安装'; exit 1; }
command -v tmux >/dev/null 2>&1 || warn '没找到 tmux：看板照样能看，但要从网页回复 / 在文件夹启动 Claude 需要 tmux'
if command -v tailscale >/dev/null 2>&1; then info "Tailscale 地址：$(tailscale ip -4 2>/dev/null | head -1 || true)"; else warn '没找到 Tailscale：agent 要经 Tailscale 连到群晖，请先安装并登录'; fi
command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ] || warn '没找到 claude（Claude Code）：hooks 照样安装，装好后即可生效'
command -v systemctl >/dev/null 2>&1 || { warn '没有 systemd，没法设置开机自启'; exit 1; }

step '获取代码'
HERE=$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || true)
if [ -n "$HERE" ] && [ -f "$HERE/../headless/ame-headless.js" ]; then DIR=$(cd "$HERE/.." && pwd); info "使用当前仓库：$DIR"
elif [ -d "$DIR/.git" ]; then info "更新 $DIR"; git -C "$DIR" pull --ff-only
else info "克隆到 $DIR"; git clone -b "$BRANCH" "$REPO" "$DIR"; fi

step '安装依赖'
(cd "$DIR/remote" && PATH="$(dirname "$NODE"):$PATH" "$NPM" ci --omit=dev --no-audit --no-fund)

# ---------------------------------------------------------------------------------------------------------------
step '配置 agent'
AGENT="$DIR/remote/agent/agent.json"
if [ -f "$AGENT" ] && yes '已有 agent.json，保留它？' y AME_KEEP; then :
else
  server=$(ask '看板服务器（群晖的 agent 入口）' "$SERVER" AME_SERVER)
  name=$(ask '这台机器在看板上的名字' "$(hostname | tr '[:upper:]' '[:lower:]')" AME_NAME)
  info '在群晖上生成这台机器的令牌（ssh 到群晖后运行）：'
  printf '     \033[36m/var/packages/Node.js_v22/target/usr/local/bin/node /volume2/docker/ame-remote/remote/server/setup.js add-agent %s\033[0m\n' "$name"
  if [ -n "${AME_TOKEN:-}" ]; then token=$AME_TOKEN; else read -r -s -p '   把打印出来的令牌粘贴到这里（不显示）: ' token </dev/tty; echo; fi
  [ ${#token} -ge 30 ] || { warn '令牌不对（太短）'; exit 1; }
  if yes '允许从看板远程控制（回复、审批、在文件夹启动 Claude）？' y AME_CONTROL; then control=true; else control=false; fi
  # the default is your home folder without what starts with "." (tools keep logins and histories there); folders you
  # name yourself are opened as they are
  files=$(ask '文件浏览：home=你的主目录（不含 . 开头的），或写文件夹（逗号分隔），none=不开放' home AME_FILES)
  # written by node: proper JSON escaping, readable by this user only
  AME_S="$server" AME_T="$token" AME_N="$name" AME_C="$control" AME_F="$files" "$NODE" -e '
    const e = process.env, j = { server: e.AME_S, token: e.AME_T.trim(), name: e.AME_N, control: e.AME_C === "true" };
    if (e.AME_F === "home") j.files = { roots: [{ path: "~", hideDot: true }] };
    else if (e.AME_F !== "none") j.files = { roots: e.AME_F.split(",").map((s) => s.trim()).filter(Boolean) };
    require("fs").writeFileSync(process.argv[1], JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });' "$AGENT"
  chmod 600 "$AGENT"
  info "已写入 $AGENT"
fi

step '安装 Claude Code hooks（原设置会先备份）'
"$NODE" "$DIR/headless/install-hooks.js"

step '启动 Claude 前的准备（从看板在文件夹启动 Claude 时用）'
mkdir -p "$HOME/.ametyping"
if [ -f "$HOME/.ametyping/launch.sh" ]; then info "已有 ~/.ametyping/launch.sh：$(grep -v '^#' "$HOME/.ametyping/launch.sh" | head -1)"
else
  pre=$(ask '启动 claude 前要执行的命令，例如设代理：source ~/proxy.sh（没有就直接回车）' '' AME_LAUNCH)
  if [ -n "$pre" ]; then printf '# sourced by the AmeTyping headless service before it starts claude from the dashboard\n%s\n' "$pre" > "$HOME/.ametyping/launch.sh"; info '已写入 ~/.ametyping/launch.sh'; fi
fi

# ---------------------------------------------------------------------------------------------------------------
step 'systemd 用户服务（开机自启、崩溃自动重启）'
UNITS="$HOME/.config/systemd/user"; mkdir -p "$UNITS"
for u in ame-headless ame-agent; do
  sed "s#@NODE@#$NODE#g; s#@ROOT@#$DIR#g" "$DIR/headless/deploy/$u.service" > "$UNITS/$u.service"
done
systemctl --user daemon-reload
systemctl --user enable ame-headless ame-agent >/dev/null 2>&1
systemctl --user restart ame-headless ame-agent
sleep 2
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
  warn '还没开启 linger：你所有登录（包括 ssh）都断开后，服务会被系统停掉'
  if yes '现在用 sudo 开启（需要输入 sudo 密码）？' y AME_LINGER; then sudo loginctl enable-linger "$USER" </dev/tty && info 'linger 已开启'; else info "稍后手动运行：sudo loginctl enable-linger $USER"; fi
fi

step '完成'
info "无头服务：$(systemctl --user is-active ame-headless)"
info "agent：$(systemctl --user is-active ame-agent)（日志：journalctl --user -u ame-agent -n 20）"
info '打开 https://win98.huatan.org 应能在「网上邻居」里看到这台机器。'
info '要从看板回复，claude 需要在 tmux 里运行；已经开着的 Claude Code 会话要重开一次才会用上新 hooks。'
