#!/bin/bash
# NAS 端的 Python 环境，给 embedding 服务的调用、压测和以后的向量检索用。
# 全部装在 volume2（SSD）的 /volume2/docker/ame-embed 下，不需要 sudo；可以重复运行（已装好的步骤会跳过）。
#
#   bash /volume2/docker/ame-embed/nas-embed-env.sh
#
# 结果：
#   /volume2/docker/ame-embed/miniforge3                   Miniforge（conda，默认 conda-forge 源）
#   /volume2/docker/ame-embed/miniforge3/envs/ame-embed    Python 3.12 + numpy + requests + matplotlib + sqlite-vec
#   conda 包缓存、pip 缓存也放在 /volume2/docker/ame-embed/cache，不占家目录（volume1）
# 以后用：/volume2/docker/ame-embed/miniforge3/envs/ame-embed/bin/python 脚本.py   （不需要 conda activate）
#
# 网络：GitHub 和 conda-forge 走 NAS 上能用的代理。下面默认不设代理，
# 要用代理就先 export HTTPS_PROXY=http://地址:端口 再运行。
set -euo pipefail

BASE="/volume2/docker/ame-embed"
PREFIX="$BASE/miniforge3"
ENV="ame-embed"
INSTALLER="$BASE/Miniforge3-Linux-x86_64.sh"
export CONDA_PKGS_DIRS="$BASE/cache/conda-pkgs"
export PIP_CACHE_DIR="$BASE/cache/pip"
export TMPDIR="$BASE/cache/tmp"
export XDG_CACHE_HOME="$BASE/cache/xdg"   # conda 自己的小缓存，否则会写到 ~/.cache
mkdir -p "$BASE" "$CONDA_PKGS_DIRS" "$PIP_CACHE_DIR" "$TMPDIR" "$XDG_CACHE_HOME"
# 群晖没有 ldd 和 getconf，Miniforge 安装器查不到 glibc 版本会拒绝安装（显示 "system has ."）。
# libc.so.6 本身可以运行，第一行是 "GNU C Library ... version 2.36."，从这里读出真实版本告诉安装器。
if [ -z "${CONDA_OVERRIDE_GLIBC:-}" ] && ! command -v ldd >/dev/null 2>&1; then
  for so in /lib64/libc.so.6 /lib/libc.so.6 /lib/x86_64-linux-gnu/libc.so.6; do
    [ -x "$so" ] || continue
    CONDA_OVERRIDE_GLIBC="$("$so" 2>/dev/null | head -1 | sed -n 's/.*version \([0-9][0-9.]*[0-9]\).*/\1/p')"
    [ -n "$CONDA_OVERRIDE_GLIBC" ] && break
  done
  if [ -z "${CONDA_OVERRIDE_GLIBC:-}" ]; then echo "读不出 glibc 版本，手动 export CONDA_OVERRIDE_GLIBC=版本号 再运行" >&2; exit 1; fi
  export CONDA_OVERRIDE_GLIBC
  echo "== 没有 ldd，按 libc.so.6 报告的 glibc $CONDA_OVERRIDE_GLIBC 安装"
fi
URL="https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh"

if [ ! -x "$PREFIX/bin/conda" ]; then
  echo "== 下载 Miniforge"
  curl -fL --retry 3 -o "$INSTALLER" "$URL"
  echo "== 安装到 $PREFIX（不改 .bashrc）"
  bash "$INSTALLER" -b -p "$PREFIX"
  rm -f "$INSTALLER"
else
  echo "== Miniforge 已在 $PREFIX，跳过"
fi

if [ ! -x "$PREFIX/envs/$ENV/bin/python" ]; then
  echo "== 创建环境 $ENV"
  "$PREFIX/bin/conda" create -y -n "$ENV" python=3.12 numpy requests matplotlib
else
  echo "== 环境 $ENV 已存在，跳过创建"
fi

echo "== 装 sqlite-vec（SQLite 的向量扩展，以后做混合检索用）"
"$PREFIX/envs/$ENV/bin/python" -m pip install -q --upgrade sqlite-vec

echo "== 自检"
"$PREFIX/envs/$ENV/bin/python" - <<'EOF'
import sqlite3, sys
import numpy, requests, matplotlib, sqlite_vec
db = sqlite3.connect(':memory:')
db.enable_load_extension(True)
sqlite_vec.load(db)
print('python', sys.version.split()[0], '| numpy', numpy.__version__, '| sqlite', sqlite3.sqlite_version,
      '| sqlite-vec', db.execute('select vec_version()').fetchone()[0])
EOF
echo "== 好了：$PREFIX/envs/$ENV/bin/python"
