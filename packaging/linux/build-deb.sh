#!/bin/bash
# 把 OpenCodex 打成一个 Debian 包：启动器 + systemd 自动服务。
#
# 用法：
#   packaging/linux/build-deb.sh [--version X.Y.Z] [--arch amd64] [--out release] [--keep-staging]
#
# 产物：<out>/opencodex_<version>_<arch>.deb
#
# 前提：先跑过 `pnpm run build`（gateway/dist 是本包的唯一运行时来源，仓库里不入库）。
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PKG_DIR="$REPO_ROOT/packaging/linux"
STAGING_ROOT="$REPO_ROOT/build/deb"

VERSION=""
ARCH="amd64"
OUT_DIR="$REPO_ROOT/release"
KEEP_STAGING=0

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --keep-staging) KEEP_STAGING=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$VERSION" ]; then
  VERSION=$(node -p "require('$REPO_ROOT/package.json').version")
fi

PKG_NAME="opencodex_${VERSION}_${ARCH}"
STAGE="$STAGING_ROOT/$PKG_NAME"

echo "== OpenCodex deb 构建"
echo "   版本: $VERSION"
echo "   架构: $ARCH"
echo "   暂存: $STAGE"

# ---- 0. 前置检查 ----
if [ ! -f "$REPO_ROOT/gateway/dist/modification/catalog.js" ]; then
  echo "缺少 gateway/dist，请先执行：pnpm run build" >&2
  exit 1
fi
if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "缺少 dpkg-deb，请安装 dpkg-dev" >&2
  exit 1
fi

# 模板文件缺失时 dpkg-deb 要到最后一步才报错，这里提前逐个确认，报错更直观。
# （踩过的坑：.gitignore 的 config.yaml 规则会把打包模板一起忽略，导致 CI 上缺文件。）
REQUIRED_TEMPLATES="packaging/linux/debian/control.in \
packaging/linux/debian/conffiles \
packaging/linux/debian/postinst \
packaging/linux/debian/prerm \
packaging/linux/debian/postrm \
packaging/linux/debian/opencodex.desktop \
packaging/linux/etc/gateway.env \
packaging/linux/etc/config.yaml \
packaging/linux/systemd/opencodex-gateway.service \
packaging/linux/systemd/opencodex-xvfb.service \
packaging/linux/systemd/opencodex-payload.service \
packaging/linux/bin/opencodex-gateway \
packaging/linux/run-gateway.sh \
packaging/linux/install-payload.sh"
missing=""
for template in $REQUIRED_TEMPLATES; do
  [ -f "$REPO_ROOT/$template" ] || missing="$missing $template"
done
if [ -n "$missing" ]; then
  echo "缺少打包模板文件，请确认它们已入库：$missing" >&2
  echo "提示：git ls-files --error-unmatch <路径> 可确认是否被 .gitignore 忽略。" >&2
  exit 1
fi

# 已装版本必须与 package.json 一致，避免打出内容与版本号不符的包。
SYNCED_VERSION=$(sed -n 's/^const OPENCODEX_VERSION = "\(.*\)";$/\1/p' "$REPO_ROOT/shared/app-version.cjs")
if [ "$SYNCED_VERSION" != "$VERSION" ]; then
  echo "shared/app-version.cjs 是 $SYNCED_VERSION，与 $VERSION 不一致；请先跑 pnpm run sync:version" >&2
  exit 1
fi

# ---- 1. 应用树 ----
rm -rf "$STAGE"
mkdir -p "$STAGE/DEBIAN" \
  "$STAGE/opt/opencodex" \
  "$STAGE/usr/bin" \
  "$STAGE/usr/share/applications" \
  "$STAGE/usr/share/icons/hicolor/512x512/apps" \
  "$STAGE/usr/share/doc/opencodex" \
  "$STAGE/lib/systemd/system" \
  "$STAGE/etc/opencodex"

APP_DIR="$STAGE/opt/opencodex"
copy_tree() {
  local rel="$1"
  [ -e "$REPO_ROOT/$rel" ] || return 0
  mkdir -p "$APP_DIR/$(dirname "$rel")"
  cp -a "$REPO_ROOT/$rel" "$APP_DIR/$rel"
}

copy_tree gateway/main.cjs
copy_tree gateway/dev
copy_tree gateway/runner
copy_tree gateway/runtime
copy_tree gateway/dist
copy_tree web-shell
copy_tree shared
copy_tree launcher
copy_tree package.json
copy_tree config.example.yaml
copy_tree LICENSE
copy_tree README.md
copy_tree deploy.md

printf '%s\n' "$VERSION" > "$APP_DIR/VERSION"
install -m 0755 "$PKG_DIR/run-gateway.sh" "$APP_DIR/run-gateway.sh"
install -m 0755 "$PKG_DIR/install-payload.sh" "$APP_DIR/install-payload.sh"

# ---- 2. 生产依赖 ----
# 必须用 pnpm 在生产依赖根里重装一遍：pnpm 把传递依赖放在 .pnpm 下并用符号链接暴露，
# 只复制顶层包目录带不出传递依赖（例如 @electron/asar 需要 minimatch），运行时会 ERR_MODULE_NOT_FOUND。
PROD_DEPS=$(node -p "Object.keys(require('$REPO_ROOT/package.json').dependencies).join(' ')")
DEPS_STAGE="$STAGING_ROOT/.deps-${VERSION}-${ARCH}"
rm -rf "$DEPS_STAGE"
mkdir -p "$DEPS_STAGE"
cp -a "$REPO_ROOT/package.json" "$REPO_ROOT/pnpm-lock.yaml" "$REPO_ROOT/pnpm-workspace.yaml" "$DEPS_STAGE/"
( cd "$DEPS_STAGE" && pnpm install --prod --ignore-scripts --frozen-lockfile --config.verify-deps-before-run=false >/dev/null )
cp -a "$DEPS_STAGE/node_modules" "$APP_DIR/node_modules"
rm -rf "$DEPS_STAGE"

# 装完立刻在包内树里逐个 require 一次：缺依赖要在打包时就暴露，而不是装到目标机上才炸。
( cd "$APP_DIR" && PROD_DEPS="$PROD_DEPS" node -e \
  'for (const dep of (process.env.PROD_DEPS || "").split(" ").filter(Boolean)) { require(dep); }' )
echo "   生产依赖: $(find "$APP_DIR/node_modules" -type f | wc -l) 个文件"

# ---- 2b. 离线 payload（可选）----
# 目标机没有外网时，把需要一并安装的 .deb 放进 packaging/linux/payload/，
# 构建时会被打进包里，由 postinst 在安装阶段用 dpkg 装上（节点运行时、官方 code-app 等）。
PAYLOAD_DIR="$PKG_DIR/payload"
BUNDLED_PAYLOAD=0
if [ -d "$PAYLOAD_DIR" ]; then
  shopt -s nullglob
  payload_debs=("$PAYLOAD_DIR"/*.deb)
  shopt -u nullglob
  if [ ${#payload_debs[@]} -gt 0 ]; then
    mkdir -p "$APP_DIR/payload"
    cp -a "${payload_debs[@]}" "$APP_DIR/payload/"
    BUNDLED_PAYLOAD=${#payload_debs[@]}
  fi
fi
if [ "$BUNDLED_PAYLOAD" -gt 0 ]; then
  echo "   离线 payload: $BUNDLED_PAYLOAD 个 .deb，合计 $(du -sh "$APP_DIR/payload" | cut -f1)"
else
  echo "   离线 payload: 无（依赖由 Depends 声明，安装时需要能访问 apt 源）"
fi

# ---- 3. 启动器 / 服务 / 配置 / 图标 ----
install -m 0755 "$PKG_DIR/bin/opencodex-gateway" "$STAGE/usr/bin/opencodex-gateway"
install -m 0644 "$PKG_DIR/systemd/opencodex-gateway.service" "$STAGE/lib/systemd/system/opencodex-gateway.service"
install -m 0644 "$PKG_DIR/systemd/opencodex-xvfb.service" "$STAGE/lib/systemd/system/opencodex-xvfb.service"
install -m 0644 "$PKG_DIR/systemd/opencodex-payload.service" "$STAGE/lib/systemd/system/opencodex-payload.service"
install -m 0644 "$PKG_DIR/etc/gateway.env" "$STAGE/etc/opencodex/gateway.env"
install -m 0644 "$PKG_DIR/etc/config.yaml" "$STAGE/etc/opencodex/config.yaml"
install -m 0644 "$PKG_DIR/debian/opencodex.desktop" "$STAGE/usr/share/applications/opencodex.desktop"
install -m 0644 "$REPO_ROOT/web-shell/assets/icon.png" "$STAGE/usr/share/icons/hicolor/512x512/apps/opencodex.png"

# Debian 策略要求包内附带版权文件。
install -m 0644 "$REPO_ROOT/LICENSE" "$STAGE/usr/share/doc/opencodex/copyright"

# ---- 4. 控制信息与维护脚本 ----
sed -e "s/@VERSION@/$VERSION/g" -e "s/@ARCH@/$ARCH/g" \
  "$PKG_DIR/debian/control.in" > "$STAGE/DEBIAN/control"
install -m 0644 "$PKG_DIR/debian/conffiles" "$STAGE/DEBIAN/conffiles"
for script in postinst prerm postrm; do
  install -m 0755 "$PKG_DIR/debian/$script" "$STAGE/DEBIAN/$script"
done

# ---- 5. 打包 ----
mkdir -p "$OUT_DIR"
DEB_PATH="$OUT_DIR/${PKG_NAME}.deb"
# --root-owner-group：包内文件统一 root:root，不需要 fakeroot。
dpkg-deb --build --root-owner-group "$STAGE" "$DEB_PATH" >/dev/null

if [ "$KEEP_STAGING" -eq 0 ]; then
  rm -rf "$STAGE"
fi

echo
echo "== 完成"
ls -la "$DEB_PATH"
echo "sha256: $(sha256sum "$DEB_PATH" | cut -d' ' -f1)"
echo
echo "包内摘要："
dpkg-deb -c "$DEB_PATH" | awk '{print $1, $6}' | grep -c . | sed 's/^/  文件数: /'
dpkg-deb -f "$DEB_PATH" Package Version Architecture Depends | sed 's/^/  /'
