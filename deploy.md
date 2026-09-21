# OpenCodex Linux 部署指南（deb 包：启动器 + 自动服务）

> 适用：Debian / Ubuntu x86_64（在 Ubuntu 22.04 上实测）。
> 覆盖三件事：**构建 deb 包** → **安装并配置** → **验证与升级**。
> 包会把本项目的集成补丁、构建产物、Node 依赖闭包一并带走，并注册 systemd 自动服务。
> 上游基础说明见 [docs/LINUX_GUIDE.md](docs/LINUX_GUIDE.md)。

## 0. 这个包解决什么

仓库里带了一组针对无外网 Linux 服务器的补丁（站点品牌替换、出站域名拦截、无头 Electron 参数、
资源缓存与遥测短路等）。这些补丁散落在 gateway / web-shell / launcher 三棵树里，手工同步容易漏、
也不好做升级和回滚。deb 把三样东西固化成一个可安装、可卸载、可开机自启的单元：

| 组成 | 说明 |
|---|---|
| **构建后的应用包** | `gateway/dist`、`web-shell`、`launcher` 与生产 Node 依赖闭包，装到 `/opt/opencodex` |
| **Node 22/24 依赖** | `Depends: nodejs (>= 22)`，apt 负责装；离线机器可用随包 payload |
| **code-app 的依赖** | 官方 ChatGPT 桌面端所需的约 37 个 GTK/X11/音频库，全部写进 `Depends` |

外加启动器 `/usr/bin/opencodex-gateway`、两个 systemd 单元（网关 + Xvfb）与服务账户 `opencodex`。

| 落地位置 | 内容 |
|---|---|
| `/opt/opencodex` | 应用树、生产依赖、`run-gateway.sh`、`install-payload.sh`、`VERSION` |
| `/usr/bin/opencodex-gateway` | 启动器 |
| `/lib/systemd/system/opencodex-{gateway,xvfb,payload}.service` | 网关、虚拟显示、离线 payload 安装 |
| `/etc/opencodex/{gateway.env,config.yaml}` | conffile，升级不覆盖本地改动 |
| `/var/lib/opencodex`、`/var/log/opencodex` | 状态与日志，属主 `opencodex` |
| `/usr/share/applications/opencodex.desktop` | 桌面入口 |

> 命令名是 **`opencodex-gateway`**，不是 `opencodex`：后者已被 npm 上的 fork 代理 CLI 占用，
> 同名时会被 PATH 中更靠前的它遮蔽，出现「装了却调用到别的程序」的假象。

## 1. 依赖与前置条件

### 1.1 已声明的依赖（apt 会自动装）

```bash
# 构建机
sudo apt install -y dpkg-dev      # 提供 dpkg-deb
corepack enable && corepack prepare pnpm@10 --activate

# 目标机：装包时 apt 自动处理 Depends，无需手工准备
```

`Depends` 里包含三块：

1. `nodejs (>= 22)` —— 运行要求 Node 22/24。**Debian/Ubuntu 22.04 自带的 nodejs 是 12**，
   需要先加 NodeSource 源；没有外网时走 §5 的离线 payload。
2. `xvfb`、`adduser`、`ca-certificates` —— 虚拟显示与服务账户所需。
3. 约 37 个库（`libgtk-3-0`、`libnss3`、`libgbm1`、`libasound2`…）—— 与官方 code-app 的
   依赖表一致，装本包等于把 Codex Desktop 运行时的系统依赖一并铺好。

### 1.2 配置 NodeSource（有外网时）

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # v22.x 或 v24.x
```

## 2. 构建 deb

```bash
git clone https://github.com/yorkane/OpenCodex.git
cd OpenCodex
git checkout codex/brand-network-overlay      # 带品牌/域名补丁的功能分支

pnpm install
pnpm run build            # 产出 gateway/dist —— 包只从这里取运行时
bash packaging/linux/build-deb.sh
```

可选参数：

```bash
bash packaging/linux/build-deb.sh --version 2.2.0 --arch amd64 --out release --keep-staging
```

产物与判据：

```bash
ls -la release/opencodex_2.2.0_amd64.deb
dpkg-deb -f release/opencodex_2.2.0_amd64.deb Package Version Architecture
dpkg-deb -f release/opencodex_2.2.0_amd64.deb Depends | tr ',' '\n' | grep -E 'nodejs|libgtk-3-0'
dpkg-deb -c release/opencodex_2.2.0_amd64.deb | grep usr/bin     # 应看到 opencodex-gateway
```

构建脚本会在打包阶段做三道自检，任一条不满足直接失败：

1. `gateway/dist/modification/catalog.js` 必须存在（否则提示先跑 `pnpm run build`）；
2. `shared/app-version.cjs` 的版本必须与 `package.json` 一致（`pnpm run sync:version`）；
3. 在包内树里逐个 `require` 生产依赖 —— 专门拦「只复制顶层包、漏掉 pnpm 传递依赖」的坑
   （`@electron/asar` 需要 `minimatch`，只拷顶层目录会在运行时 `ERR_MODULE_NOT_FOUND`）。

## 3. 安装

```bash
# 推荐：用 apt 装，会自动补齐 Depends
sudo apt install -y ./release/opencodex_2.2.0_amd64.deb

# 或者 dpkg 装，再补依赖
sudo dpkg -i release/opencodex_2.2.0_amd64.deb
sudo apt-get -f install -y
```

`postinst` 会自动：启用 `opencodex-xvfb` 与 `opencodex-gateway`，建服务账户与运行时目录，
并启用 `opencodex-payload`（离线 payload 安装单元，见 §5；没带 payload 时它是空操作）。

### 3.1 端口或显示号冲突

```bash
# 本机已有 Xvfb 占用 :99 时改显示号（两个单元共用这一个变量）
sudo sed -i 's/^DISPLAY=:99$/DISPLAY=:98/' /etc/opencodex/gateway.env
# 3737 被占用时改端口
sudo sed -i 's/^PORT=3737$/PORT=13739/' /etc/opencodex/gateway.env
sudo systemctl restart opencodex-gateway.service
```

## 4. 配置 Codex Desktop 运行时

包**不含**官方运行时本体，只含它需要的系统依赖。运行时有两种来源，二选一，
然后把路径写进 `/etc/opencodex/gateway.env`。

### 4.1 路线 A：官方 deb（推荐）

```bash
# 解开即可，不要 dpkg -i（路径要与配置一致）
sudo mkdir -p /usr/lib/chatgpt
sudo dpkg-deb -x chatgpt_26.908.40834_amd64.deb /usr/lib/chatgpt
ls /usr/lib/chatgpt/ChatGPT /usr/lib/chatgpt/resources/app.asar
grep -aoE '26\.908\.[0-9]{5}' /usr/lib/chatgpt/resources/app.asar | head -1   # 版本校验
```

```ini
CODEX_DESKTOP_APP_PATH=/usr/lib/chatgpt/resources/app.asar
CODEX_DESKTOP_EXECUTABLE_PATH=/usr/lib/chatgpt/ChatGPT
CODEX_CLI_PATH=/usr/lib/chatgpt/resources/codex
```

若想让 deb 顺手把这个运行时也装上，见 §5 的 payload（把 chatgpt_.*_amd64.deb 放进去即可）。

### 4.2 路线 B：社区转换目录

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git /opt/codex-desktop-linux
cd /opt/codex-desktop-linux && make bootstrap-native
grep -aoE '26\.908\.[0-9]{5}' resources/app.asar | head -1   # 版本校验
```

```ini
CODEX_DESKTOP_APP_PATH=/opt/codex-desktop-linux/codex-app
CODEX_DESKTOP_EXECUTABLE_PATH=/opt/codex-desktop-linux/codex-app/electron
```

## 5. 离线 payload（无外网机器）

无外网时，把要一并安装的 `.deb` 放进 `packaging/linux/payload/` 再构建 —— 它们会被打进包里，
安装时由 `opencodex-payload.service` 自动装上。典型内容：

| 放进 payload 的包 | 用途 |
|---|---|
| `nodejs_22.*_amd64.deb` | 满足 `nodejs (>= 22)`，替代 NodeSource |
| `chatgpt_26.908.*_amd64.deb` | 官方 Codex Desktop 运行时本体 |
| 其余 `.deb` | 目标机缺的其它依赖（如 `xvfb`、各 GTK/X11 库） |

```bash
mkdir -p packaging/linux/payload
cp nodejs_22.*_amd64.deb chatgpt_26.908.*_amd64.deb packaging/linux/payload/
bash packaging/linux/build-deb.sh        # 会打印 "离线 payload: N 个 .deb"
```

### 为什么不是 postinst 直接装

dpkg 在运行 maintainer script 期间持有前端锁，脚本里再调 `dpkg -i` 会直接失败：

```text
dpkg: error: dpkg frontend lock was locked by another process
```

所以安装交给 systemd 一次性单元，在安装结束、锁释放之后执行。它带两个条件，
因此天然幂等：`ConditionPathExists=/opt/opencodex/payload` 且 `!/var/lib/opencodex/.payload-installed`。

```bash
# 不重启机器也能立刻补装（装完 opencodex 之后执行）
opencodex-gateway install-payload      # 内部即 systemctl start opencodex-payload.service
systemctl status opencodex-payload.service --no-pager
cat /var/log/opencodex/payload-install.log
```

装完后 payload 里的 `.deb` 仍留在 `/opt/opencodex/payload/`（属于本包文件，不自动删除）；
空间紧张时可以手工清理，但清理后 `dpkg -V opencodex` 会报告文件缺失。

## 6. 站点配置

两个文件都是 conffile，升级不会覆盖你的改动。

### 6.1 `/etc/opencodex/gateway.env`（进程环境）

```ini
HOST=127.0.0.1          # 对外提供服务时改 0.0.0.0，并前置带认证的反向代理
PORT=3737
DISPLAY=:99              # 与 opencodex-xvfb.service 共用
OPENCODEX_HEADLESS_ELECTRON=1   # 无头服务器必须为 1；桌面机上删掉
CODEX_DESKTOP_APP_PATH=...
CODEX_DESKTOP_EXECUTABLE_PATH=...
CODEX_HOME=/var/lib/opencodex/codexhome
```

> 这是 systemd `EnvironmentFile`，写法是 `KEY=value`，**不要写 `export`**。

### 6.2 `/etc/opencodex/config.yaml`（站点配置）

```yaml
auth:
  password: ""            # 本机自查用；前置了认证代理时留空

brand:
  name: "wdev"            # 界面上所有 Codex / ChatGPT / OpenAI 文案与标识都换成它

network:
  block:                  # 命中即本地拦截，不发真实请求
    - "*.chatgpt.com"
    - "chatgpt.com"
    - "*.openai.com"
    - "*.oaiusercontent.com"
    - "*.statsig.com"
    - "statsigapi.net"
  allow: []               # 在被拉黑的域族里开洞，优先级高于 block
```

改完 `opencodex-gateway restart`。`*.example.com` 只匹配子域，不匹配 `example.com` 本身；
品牌名也可用环境变量 `OPENCODEX_BRAND_NAME` 覆盖（优先级：环境变量 > config.yaml > 默认 `OpenCodex`）。

**模型流量不在拦截范围内**：它由官方 app-server 子进程直接发往本机代理，不经过浏览器出站通道。

## 7. 启动器 `opencodex-gateway`

```bash
opencodex-gateway start       # 启动虚拟显示 + 网关
opencodex-gateway status      # 服务状态 + 当前访问地址
opencodex-gateway url         # 只打印访问地址
opencodex-gateway open        # 用桌面默认浏览器打开
opencodex-gateway logs 200    # 最近 200 行
opencodex-gateway config      # 编辑 config.yaml
opencodex-gateway env         # 编辑 gateway.env
opencodex-gateway restart
opencodex-gateway stop
opencodex-gateway enable      # 开机自启（默认已启用）
opencodex-gateway disable
opencodex-gateway install-payload   # 补装随包离线 payload
opencodex-gateway version
```

不带参数等价于 `status`。桌面环境也可以点应用菜单里的 **OpenCodex**。

## 8. 验证判据

```bash
# 1) 服务在跑且没有反复重启
systemctl is-active opencodex-gateway.service opencodex-xvfb.service    # active active
systemctl is-enabled opencodex-gateway.service                           # enabled
systemctl show -p NRestarts --value opencodex-gateway.service            # 0

# 2) 健康检查与站点品牌
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3737/healthz   # 200
curl -s http://127.0.0.1:3737/ | grep -oE '<title>[^<]*</title>'           # <title>wdev</title>
curl -s http://127.0.0.1:3737/manifest.webmanifest | grep -o '"name": "[^"]*"'

# 3) 品牌与拦截策略确实下发到了浏览器
curl -s http://127.0.0.1:3737/codex-web-config.js | grep -oE 'brand: \{[^}]*\}'
curl -s http://127.0.0.1:3737/codex-web-config.js | grep -oE 'network: \{[^}]*\}'

# 4) 三个新增 Provider 都能取到
for p in codex-brand-text codex-network-guard codex-menu-item-guard; do
  curl -s -o /dev/null -w "$p %{http_code}\n" http://127.0.0.1:3737/$p.js
done

# 5) 骨架修改点齐全（本分支为 109 个）
curl -s http://127.0.0.1:3737/api/opencodex/runtime-compatibility |
  python3 -c 'import json,sys;d=json.load(sys.stdin);print(len((d.get("compatibility") or d).get("points") or []))'

# 6) 若带了离线 payload
systemctl is-active opencodex-payload.service && ls -la /var/lib/opencodex/.payload-installed
```

浏览器侧（可选，需要一台能访问该网关的机器）：确认左下角账号名与账号菜单标题是品牌名、
帮助菜单里没有「新功能/帮助」、账号菜单里没有「显示宠物」。

## 9. 升级与卸载

```bash
# 升级：重装新包；conffile 会保留并在 /etc/opencodex 留 .dpkg-dist 供对比
sudo apt install -y ./release/opencodex_2.3.0_amd64.deb
diff /etc/opencodex/gateway.env /etc/opencodex/gateway.env.dpkg-dist

# 卸载（保留配置与状态）
sudo dpkg -r opencodex

# 彻底清除（连 /var/lib/opencodex、/var/log/opencodex、payload 标记与服务账户一起删）
sudo dpkg -P opencodex
```

`prerm` 先停服务，避免删到正在运行的文件；`postrm purge` 清目录、payload 完成标记与账户。

## 10. 故障排查

### 服务起不来

```bash
opencodex-gateway logs 200
journalctl -u opencodex-gateway -n 200 --no-pager
sudo tail -100 /var/log/opencodex/gateway.log
```

### `Cannot open display`

`opencodex-xvfb.service` 没起来，或 `DISPLAY` 与它的显示号不一致。

```bash
systemctl status opencodex-xvfb --no-pager
pgrep -a Xvfb                     # 确认显示号；:99 被占用就改成 :98
```

### Electron 直接退出 / 白屏

确认 `/etc/opencodex/gateway.env` 里有 `OPENCODEX_HEADLESS_ELECTRON=1`。缺了它不会追加
`--no-sandbox --headless --disable-gpu`，服务器上 Chromium 会 FATAL 退出。

### 提示找不到官方运行时

`CODEX_DESKTOP_APP_PATH` / `CODEX_DESKTOP_EXECUTABLE_PATH` 与 §4 实际路径不一致。
注意路线 A 指向 `app.asar` 文件，路线 B 指向解包目录。

### 装包时报依赖不满足

用 `apt install ./xxx.deb` 而不是裸 `dpkg -i`；已经是 dpkg 装的，跑 `sudo apt-get -f install` 收尾。

### payload 没装上

```bash
systemctl status opencodex-payload.service --no-pager
sudo cat /var/log/opencodex/payload-install.log     # 失败原因都在这里
ls -la /opt/opencodex/payload/                      # 确认包确实带进来了
```

### 端口冲突

```bash
ss -ltnp | grep -E ':(3737|10101)'   # 10101 是 fork 代理，与网关无关
```

### 装了以后执行的却是别的程序

`which -a opencodex` 可能同时列出 npm 全局的 fork 代理 CLI。本包的命令是 `opencodex-gateway`，不会冲突。

## 11. 包内结构（对照）

```text
/opt/opencodex/
  gateway/{main.cjs,dev,runner,runtime,dist}   应用本体（dist 为构建产物）
  web-shell/                                   前端壳与内置 Provider 脚本
  launcher/                                    桌面启动器
  shared/                                      版本号等共享模块
  node_modules/                                生产依赖闭包（pnpm --prod 生成）
  run-gateway.sh                               systemd ExecStart 包装脚本
  install-payload.sh                           离线 payload 安装脚本
  payload/                                     随包携带的第三方 .deb（可选）
  VERSION                                      包版本
/usr/bin/opencodex-gateway                     启动器
/usr/share/applications/opencodex.desktop      桌面入口
/usr/share/icons/hicolor/512x512/apps/opencodex.png
/lib/systemd/system/opencodex-gateway.service
/lib/systemd/system/opencodex-xvfb.service
/lib/systemd/system/opencodex-payload.service
/etc/opencodex/gateway.env                     conffile
/etc/opencodex/config.yaml                     conffile
```

## 12. 重新打包时要改的文件

| 目的 | 文件 |
|---|---|
| 依赖声明、描述 | `packaging/linux/debian/control.in` |
| 服务定义（顺序、权限、重启策略） | `packaging/linux/systemd/*.service` |
| 默认环境与站点配置 | `packaging/linux/etc/*` |
| 启动器命令 | `packaging/linux/bin/opencodex-gateway` |
| 安装/卸载钩子 | `packaging/linux/debian/{postinst,prerm,postrm}` |
| 离线 payload 安装逻辑 | `packaging/linux/install-payload.sh` |
| 打包流程与校验 | `packaging/linux/build-deb.sh` |
| CI 产物与发布 | `.github/workflows/build-release.yml` |

## 13. CI 产出

`.github/workflows/build-release.yml` 在本分支只构建 **Debian 包**（macOS / Windows 安装包已移除）：

1. `metadata` 识别 `chore: bump version to X.Y.Z` 提交，校验版本一致；
2. `build-deb` 在 `ubuntu-22.04` 上 `pnpm run build` 后跑 `build-deb.sh`，并解包校验启动器、
   三个单元、conffile、`gateway/dist` 与 `VERSION` 都在；
3. `release` 汇总产物创建 draft release（只有 1 个 deb 才算通过）。

CI 构建的是**不带 payload** 的变体（依赖走 `Depends`，由 apt 补齐）。
需要离线自足时在本地按 §5 加 payload 重新构建。
