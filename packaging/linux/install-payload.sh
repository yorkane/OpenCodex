#!/bin/sh
# 安装随包携带的离线 .deb（node 运行时、官方 code-app 等）。
#
# 为什么不在 postinst 里直接装：dpkg 在运行 maintainer script 时持有前端锁，
# 脚本内部再调 dpkg 会直接报 frontend lock was locked by another process。
# 因此改由 systemd 一次性单元在安装结束之后执行——那时锁已经释放。
set -eu

PAYLOAD_DIR=/opt/opencodex/payload
STAMP=/var/lib/opencodex/.payload-installed
LOG=/var/log/opencodex/payload-install.log

mkdir -p "$(dirname "$STAMP")" "$(dirname "$LOG")"

set -- "$PAYLOAD_DIR"/*.deb
if [ ! -e "$1" ]; then
  echo "opencodex: payload 目录为空，无需要安装的包" | tee -a "$LOG"
  touch "$STAMP"
  exit 0
fi

echo "opencodex: 开始安装 payload（$# 个 .deb）" | tee -a "$LOG"

# dpkg 锁可能还没从主包的安装过程中释放，先等它空出来。
attempt=0
while [ "$attempt" -lt 30 ]; do
  if fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then
    attempt=$((attempt + 1))
    sleep 2
    continue
  fi
  break
done

# 包与包之间存在依赖顺序，单趟可能装不动；多跑几趟直到没有进展。
pass=1
installed=0
while [ "$pass" -le 5 ]; do
  if dpkg -i "$PAYLOAD_DIR"/*.deb >>"$LOG" 2>&1; then
    installed=1
    echo "opencodex: payload 安装完成（第 $pass 趟）" | tee -a "$LOG"
    break
  fi
  pass=$((pass + 1))
done

# 收尾：把因顺序未配置完成的包补上。
dpkg --configure -a >>"$LOG" 2>&1 || true

if [ "$installed" = "1" ]; then
  touch "$STAMP"
  echo "opencodex: payload 已就位" | tee -a "$LOG"
else
  echo "opencodex: payload 未能装完，详见 $LOG；可在网络可用时执行 apt-get -f install 收尾" >&2
  exit 1
fi
