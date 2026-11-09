#!/bin/bash
# Real-Docker acceptance for remote/deploy/nas/docker-upgrade.sh. Run as root where Docker + compose work:
#   sudo bash docker-upgrade-e2e.sh /path/to/docker-upgrade.sh
# Everything it makes is throwaway: images ame-upg-test:*, containers ame-upg-*, a temp dir for the project, the
# registrations and the state (AME_UPG_REG / AME_UPG_STATE); busybox:latest must already be present (no pulls).
# A "new release" is made by pointing the local :latest tag at another image; AME_UPG_NOPULL=1 skips only the pull.
set -u
SCRIPT=$(readlink -f "$1")
T=$(mktemp -d /tmp/ame-upg.XXXXXX)
export AME_UPG_REG=$T/reg AME_UPG_STATE=$T/state AME_UPG_NOPULL=1 AME_UPG_WAIT=8 AME_UPG_SETTLE=3
IMG=ame-upg-test
pass=0 fail=0
ok() { if eval "$2"; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1"; fi; }
cleanup() {
  docker rm -f ame-upg-run ame-upg-c >/dev/null 2>&1
  docker image rm -f $IMG:latest $IMG:ame-rollback $IMG:v1 $IMG:v2 $IMG:bad >/dev/null 2>&1
  rm -rf "$T"
}
trap cleanup EXIT
U() { bash "$SCRIPT" "$@" 2>&1; }
wait_done() { local i; for i in $(seq 1 60); do grep -q '"state":"running"' "$AME_UPG_STATE/ame-upg-c.json" 2>/dev/null || return 0; sleep 1; done; return 1; }
st() { sed -n 's/.*"state":"\([a-z]*\)".*/\1/p' "$AME_UPG_STATE/ame-upg-c.json"; }
mk() { printf 'FROM busybox:latest\nCMD %s\n' "$2" | docker build -q -t $IMG:$1 - >/dev/null; }
use() { docker tag $IMG:$1 $IMG:latest; }

docker image inspect busybox:latest >/dev/null 2>&1 || { echo "busybox:latest is needed locally"; exit 2; }
mk v1 '["sh","-c","echo v1; sleep 3600"]'
mk v2 '["sh","-c","echo v2; sleep 3600"]'
mk bad '["sh","-c","echo bad; exit 3"]'
use v1

P=$T/proj; mkdir -p "$P"
cat > "$P/docker-compose.yml" <<EOF
services:
  app:
    image: $IMG:latest
    container_name: ame-upg-c
    restart: unless-stopped
EOF
(cd "$P" && docker compose -p ameupg up -d >/dev/null 2>&1)
docker run -d --name ame-upg-run busybox:latest sleep 3600 >/dev/null

ok 'refuses a docker run container' "U upgrade ame-upg-run | grep -q '不是 compose'"
ok 'refuses a bad name' "U upgrade '../x' | grep -q 容器名不合法"
ok 'refuses an unregistered project' "U upgrade ame-upg-c | grep -q 还没登记"
U register "$P" >/dev/null
echo '# changed' >> "$P/docker-compose.yml"
ok 'refuses after the compose file changed' "U upgrade ame-upg-c | grep -q 登记后改过"
sed -i '$d' "$P/docker-compose.yml"
echo 'X=1' > "$P/.env"
ok 'refuses after a .env appeared' "U upgrade ame-upg-c | grep -q 登记后改过"
rm -f "$P/.env"
ok 'accepts once the files are back as registered' "U upgrade ame-upg-c | grep -q 已开始"
wait_done
ok 'same image -> latest' "[ \"\$(st)\" = latest ]"

ID1=$(docker inspect --format '{{.Image}}' ame-upg-c)
use v2
U upgrade ame-upg-c >/dev/null; wait_done
ok 'new image -> done' "[ \"\$(st)\" = done ]"
ok 'container runs the new image' "docker logs ame-upg-c 2>&1 | tail -1 | grep -q v2"
ok 'old image kept as :ame-rollback' "[ \"\$(docker image inspect --format '{{.Id}}' $IMG:ame-rollback)\" = \"$ID1\" ]"

ID2=$(docker inspect --format '{{.Image}}' ame-upg-c)
use bad
U upgrade ame-upg-c >/dev/null
ok 'a second upgrade while one runs is refused' "U upgrade ame-upg-c | grep -q 正在升级"
wait_done
ok 'broken new image -> rolledback' "[ \"\$(st)\" = rolledback ]"
ok 'the previous version runs again' "[ \"\$(docker inspect --format '{{.State.Status}}|{{.Image}}' ame-upg-c)\" = \"running|$ID2\" ]"

printf '#!/bin/bash\necho deploy-ran > %s/deploy.out\n' "$T" > "$P/deploy.sh"
U register "$P" >/dev/null
U upgrade ame-upg-c >/dev/null; wait_done
ok 'a deploy.sh project runs its deploy.sh' "grep -q deploy-ran $T/deploy.out && [ \"\$(st)\" = latest ]"
ok 'state file is world-readable' "[ \"\$(stat -c %a $AME_UPG_STATE/ame-upg-c.json)\" = 644 ]"
ok 'state file is valid JSON' "node -e 'JSON.parse(require(\"fs\").readFileSync(process.argv[1]))' $AME_UPG_STATE/ame-upg-c.json 2>/dev/null || python3 -c 'import json,sys;json.load(open(sys.argv[1]))' $AME_UPG_STATE/ame-upg-c.json"

(cd "$P" && docker compose -p ameupg down >/dev/null 2>&1)
echo "== $pass passed, $fail failed"
[ "$fail" = 0 ] || { echo "-- last worker log:"; tail -30 "$AME_UPG_STATE/ame-upg-c.log" 2>/dev/null; echo "-- state:"; cat "$AME_UPG_STATE/ame-upg-c.json" 2>/dev/null; }
[ "$fail" = 0 ]
