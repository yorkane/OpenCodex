#!/bin/sh
# systemd ExecStart 包装脚本。
# 环境变量由 EnvironmentFile=/etc/opencodex/gateway.env 注入，这里只负责挑一个可用的 node。
set -eu

APP_DIR=/opt/opencodex

if [ -x /usr/bin/node ]; then
  NODE_BIN=/usr/bin/node
else
  NODE_BIN=$(command -v node || true)
fi
if [ -z "${NODE_BIN:-}" ]; then
  echo "opencodex: 找不到 node，请安装 nodejs (>= 20)" >&2
  exit 1
fi

cd "$APP_DIR"
exec "$NODE_BIN" "$APP_DIR/gateway/dev/run-gateway.cjs"
