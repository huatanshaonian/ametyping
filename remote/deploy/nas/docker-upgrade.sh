#!/bin/bash
# One-click upgrade of a compose-managed Docker container on the NAS (the dashboard's 「升级」 button).
# Installed root-owned as /usr/local/bin/ame-docker-upgrade by docker-ps-sudoers.sh; the dashboard user may run only
# "sudo -n ame-docker-upgrade upgrade <container>" without a password.
#
# Running "docker compose" as root is root on the host, so a compose project is upgraded only while its files are
# exactly as registered by an admin (a password sudo):
#   sudo ame-docker-upgrade register /volume2/docker/<name>     record docker-compose.yml, .env and deploy.sh hashes
#   sudo ame-docker-upgrade unregister /volume2/docker/<name>
#   sudo ame-docker-upgrade list
# After editing any of those files, register again; until then the upgrade refuses.
#
# upgrade <container>: runs in the background, writes /var/log/ame-docker-upgrade/<container>.json (state running /
# latest / done / failed / rolledback, readable by the dashboard) and <container>.log.
#   - a project with deploy.sh (partdb: backup + database migration) is upgraded by running that script;
#   - otherwise: compose pull of that service; same image id -> "latest", nothing recreated; else the old image is
#     kept as <repo>:ame-rollback, compose up -d, and if the container is not running (healthy, when it has a
#     healthcheck) within 180 s the old image is put back under the same tag and the service recreated from it.
set -u
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
DOCKER=/usr/local/bin/docker
# (AME_UPG_*: only for remote/test/docker-upgrade-e2e.sh; sudo resets the environment, so the dashboard user
#  cannot set them)
REG=${AME_UPG_REG:-/usr/local/etc/ame-docker-upgrade}
STATE=${AME_UPG_STATE:-/var/log/ame-docker-upgrade}
NAME_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'

die() { echo "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "需要 root（sudo）"
mkdir -p "$REG" "$STATE"; chmod 755 "$REG" "$STATE"

key_of() { printf '%s' "$1" | sha256sum | cut -c1-16; }
# the files whose content decides what root runs: compose file(s), .env (interpolated into them), deploy.sh
fingerprint() {
  local dir=$1 files=$2 f
  for f in $(printf '%s' "$files" | tr ',' ' ') "$dir/.env" "$dir/deploy.sh"; do
    if [ -e "$f" ]; then printf '%s %s\n' "$(sha256sum < "$f" | cut -d' ' -f1)" "$f"; fi
  done
}

status() { # state msg [from] [to]
  local tmp
  tmp=$(mktemp "$STATE/.st.XXXXXX")
  printf '{"name":"%s","state":"%s","msg":"%s","from":"%s","to":"%s","at":%s}\n' \
    "$CNAME" "$1" "$(printf '%s' "$2" | tr '"\\\n' "'/ " | cut -c1-300)" "${3:-}" "${4:-}" "$(date +%s)000" > "$tmp"
  chmod 644 "$tmp"; mv "$tmp" "$STATE/$CNAME.json"
}

case "${1:-}" in
  register|unregister)
    dir=$(readlink -f "${2:-}") || die "目录不存在"
    [ -d "$dir" ] || die "目录不存在：${2:-}"
    f=$dir/docker-compose.yml; [ -f "$f" ] || f=$dir/compose.yaml; [ -f "$f" ] || die "$dir 下没有 docker-compose.yml"
    k=$(key_of "$dir")
    if [ "$1" = unregister ]; then rm -f "$REG/$k"; echo "已取消登记 $dir"; exit 0; fi
    { echo "# $dir"; fingerprint "$dir" "$f"; } > "$REG/$k.tmp" && chmod 644 "$REG/$k.tmp" && mv "$REG/$k.tmp" "$REG/$k"
    echo "已登记 $dir："; tail -n +2 "$REG/$k"; exit 0 ;;
  list)
    for r in "$REG"/*; do [ -f "$r" ] && head -1 "$r" | cut -c3-; done; exit 0 ;;
  upgrade) ;;
  __worker) ;;
  *) die "用法：ame-docker-upgrade upgrade <容器名> | register <目录> | unregister <目录> | list" ;;
esac

CNAME=${2:-}
printf '%s' "$CNAME" | grep -Eq "$NAME_RE" || die "容器名不合法"
fmt='{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.Config.Image}}|{{.Image}}'
info=$($DOCKER inspect --format "$fmt" "$CNAME" 2>/dev/null) || die "找不到容器 $CNAME"
IFS='|' read -r PROJECT DIR FILES SERVICE IMAGE OLDID <<EOF
$info
EOF
[ -n "$PROJECT" ] && [ -n "$DIR" ] && [ -n "$SERVICE" ] || die "$CNAME 不是 compose 建的容器，不能一键升级（先改成 compose，见 remote/deploy/nas/DOCKER.md）"
[ -n "$FILES" ] || FILES=$DIR/docker-compose.yml
k=$(key_of "$DIR")
[ -f "$REG/$k" ] || die "$DIR 还没登记：管理员先运行 sudo ame-docker-upgrade register $DIR"
[ "$(tail -n +2 "$REG/$k")" = "$(fingerprint "$DIR" "$FILES")" ] || die "$DIR 的 compose 文件登记后改过，管理员确认后重新运行 sudo ame-docker-upgrade register $DIR"

if [ "$1" = upgrade ]; then
  exec 9>"$STATE/.$CNAME.lock"
  flock -n 9 || die "$CNAME 正在升级"
  status running "开始升级" "$(printf '%s' "${OLDID#sha256:}" | cut -c1-12)"
  setsid bash "$0" __worker "$CNAME" 9>&- </dev/null >"$STATE/$CNAME.log" 2>&1 &
  echo "已开始升级 $CNAME（后台进行，日志 $STATE/$CNAME.log）"
  exit 0
fi

# ---- worker (detached) ----
exec 9>"$STATE/.$CNAME.lock"; flock 9
short() { printf '%s' "${1#sha256:}" | cut -c1-12; }
DC() { $DOCKER compose -p "$PROJECT" --project-directory "$DIR" $(printf '%s' "$FILES" | tr ',' '\n' | sed 's/^/-f /') "$@"; }
echo "== $(date '+%F %T') $CNAME（项目 $PROJECT，服务 $SERVICE，镜像 $IMAGE）"

if [ -f "$DIR/deploy.sh" ]; then
  echo "== 用 $DIR/deploy.sh 升级"
  if (cd "$DIR" && bash ./deploy.sh); then
    NEWID=$($DOCKER inspect --format '{{.Image}}' "$CNAME" 2>/dev/null)
    if [ "$NEWID" = "$OLDID" ]; then status latest "已是最新版本（deploy.sh 已执行）" "$(short "$OLDID")" "$(short "$NEWID")"
    else status done "已升级（deploy.sh）" "$(short "$OLDID")" "$(short "$NEWID")"; fi
  else
    status failed "deploy.sh 执行失败，详见日志" "$(short "$OLDID")"
  fi
  exit 0
fi

echo "== 拉取镜像"
if [ "${AME_UPG_NOPULL:-}" = 1 ]; then echo "(test: pull skipped)"
elif ! DC pull "$SERVICE"; then
  status failed "拉取镜像失败（国内网络可能要先 sudo bash ~/docker_proxy.sh on）" "$(short "$OLDID")"; exit 0
fi
NEWID=$($DOCKER image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null)
if [ -z "$NEWID" ] || [ "$NEWID" = "$OLDID" ]; then
  status latest "已是最新版本，未重建" "$(short "$OLDID")" "$(short "$OLDID")"; exit 0
fi
REPO=${IMAGE%@*}; case "${REPO##*/}" in *:*) REPO=${REPO%:*} ;; esac
$DOCKER tag "$OLDID" "$REPO:ame-rollback" && echo "== 旧镜像保留为 $REPO:ame-rollback"

healthy() { # wait up to 180 s (AME_UPG_WAIT: rounds of 3 s, tests only)
  local i s h
  for i in $(seq 1 "${AME_UPG_WAIT:-60}"); do
    s=$($DOCKER inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CNAME" 2>/dev/null)
    h=${s#*|}; s=${s%%|*}
    if [ "$s" = running ] && { [ -z "$h" ] || [ "$h" = healthy ]; }; then
      [ -n "$h" ] || sleep "${AME_UPG_SETTLE:-10}"   # no healthcheck: still running after a while
      [ "$($DOCKER inspect --format '{{.State.Status}}' "$CNAME" 2>/dev/null)" = running ] && return 0
    fi
    [ "$h" = unhealthy ] && return 1
    sleep 3
  done
  return 1
}

echo "== 重建容器"
if DC up -d "$SERVICE" && healthy; then
  status done "已升级" "$(short "$OLDID")" "$(short "$NEWID")"; exit 0
fi
echo "== 新版本没有正常运行，回退到旧镜像"
$DOCKER tag "$OLDID" "$IMAGE"
if DC up -d "$SERVICE" && healthy; then
  status rolledback "新版本启动失败，已回退到旧版本" "$(short "$OLDID")" "$(short "$NEWID")"
else
  status failed "新版本启动失败，回退也没有成功，需要人工处理" "$(short "$OLDID")" "$(short "$NEWID")"
fi
