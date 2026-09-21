# OpenCodex Linux 部署指南（deb 包：启动器 + 自动服务）

> 适用：Debian / Ubuntu x86_64（在 Ubuntu 22.04 上实测）。
> 本文覆盖三件事：**装新版 Codex Desktop 运行时** → **装本项目的集成与补丁** → **产出并安装一个 deb 包**，
> 该包自带启动器与 systemd 自动服务。上游基础说明见 [docs/LINUX_GUIDE.md](LINUX_GUIDE.md)。

## 0. 这个包解决什么

仓库里带了一组针对无外网 Linux 服务器的补丁（站点品牌替换、出站域名拦截、无头 Electron 参数、
资源缓存与遥测短路等）。这些补丁散落在 gateway / web-shell / launcher 三棵树里，手工同步容易漏、
也不好做升级和回滚。deb 包把它们固化成一个可安装、可卸载、可开机自启的单元：

| 包内角色 | 落地位置 | 说明 |
|---|---|---|
| 应用树 | `/opt/opencodex` | gateway、web-shell、launcher、`gateway/dist` 与生产依赖 |
| 启动器 | `/usr/bin/opencodex-gateway` | `start/stop/restart/status/logs/url/open/config` |
| 自动服务 | `opencodex-gateway.service` | 网关进程，随系统启动，失败自动重启 |
| 虚拟显示 | `opencodex-xvfb.service` | 官方 Electron 运行时所需的 X 显示 |
| 配置 | `/etc/opencodex/{gateway.env,config.yaml}` | conffile，升级不覆盖本地改动 |
| 状态 | `/var/lib/opencodex`、`/var/log/opencodex` | 服务账户 `opencodex` 拥有 |
| 桌面入口 | `/usr/share/applications/opencodex.desktop` | 桌面环境下可见 |

> 命令名是 **`opencodex-gateway`**，不是 `opencodex`：后者已被 npm 上的 fork 代理 CLI 占用，
> 同名时会被 PATH 中更靠前的它遮蔽，出现「装了却调用到别的程序」的假象。

## 1. 前置条件

```bash
sudo apt update
sudo apt install -y nodejs xvfb ca-certificates adduser
node -v            # 需要 >= 20
```

打包机额外需要：

```bash
sudo apt install -y dpkg-dev      # 提供 dpkg-deb
corepack enable && corepack prepare pnpm@10 --activate   # 或已有 pnpm
```

包声明了 `Depends: nodejs (>= 20), xvfb, adduser, ca-certificates`，apt 装包时会自动补齐。

## 2. 第一步：准备 Codex Desktop 运行时

OpenAI 没有发布 Linux 桌面版，运行时有两种来源，二选一。包不含运行时，必须单独准备。

### 2.1 路线 A：官方 deb（推荐，版本最可控）

把官方 `chatgpt_<版本>_amd64.deb` 解开到固定目录（**不要 dpkg -i**，路径要与配置一致）：

```bash
sudo mkdir -p /usr/lib/chatgpt
sudo dpkg-deb -x chatgpt_26.908.40834_amd64.deb /usr/lib/chatgpt
```

校验：

```bash
ls /usr/lib/chatgpt/ChatGPT                    # Electron 可执行文件
ls /usr/lib/chatgpt/resources/app.asar         # 官方前端资源
grep -aoE '26\.908\.[0-9]{5}' /usr/lib/chatgpt/resources/app.asar | head -1   # 版本号
```

对应 `/etc/opencodex/gateway.env`：

```ini
CODEX_DESKTOP_APP_PATH=/usr/lib/chatgpt/resources/app.asar
CODEX_DESKTOP_EXECUTABLE_PATH=/usr/lib/chatgpt/ChatGPT
CODEX_CLI_PATH=/usr/lib/chatgpt/resources/codex
```

### 2.2 路线 B：社区转换目录

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git /opt/codex-desktop-linux
cd /opt/codex-desktop-linux && make bootstrap-native
```

对应配置改成解包目录（注意这里是**目录**，且含 `electron` 可执行文件）：

```ini
CODEX_DESKTOP_APP_PATH=/opt/codex-desktop-linux/codex-app
CODEX_DESKTOP_EXECUTABLE_PATH=/opt/codex-desktop-linux/codex-app/electron
```
```bash
grep -aoE '26\.908\.[0-9]{5}' /opt/codex-desktop-linux/codex-app/resources/app.asar | head -1   # 版本校验
```

## 3. 第二步：构建 deb 包

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
dpkg-deb -f release/opencodex_2.2.0_amd64.deb Package Version Architecture Depends
dpkg-deb -c release/opencodex_2.2.0_amd64.deb | grep usr/bin     # 应看到 opencodex-gateway
```

构建脚本自身会做三件校验，任何一条不满足就直接失败，避免打出内容与版本号不符的包：

1. `gateway/dist/modification/catalog.js` 必须存在（否则提示先跑 `pnpm run build`）；
2. `shared/app-version.cjs` 的版本必须与 `package.json` 一致（`pnpm run sync:version`）；
3. 在包内树里逐个 `require` 生产依赖，缺一个就报错——这一条专门拦「只复制顶层包、漏掉 pnpm 传递依赖」的坑。

## 4. 第三步：安装与首启

```bash
sudo dpkg -i release/opencodex_2.2.0_amd64.deb
# 若报依赖缺失：
# sudo apt-get -f install
```

`postinst` 会自动：建 `opencodex` 服务账户 → 建 `/var/lib/opencodex` 与 `/var/log/opencodex` →
`daemon-reload` → 启用并启动两个服务。

### 4.1 如果本机已有 Xvfb 占用 `:99`

包的 `opencodex-xvfb.service` 与网关共用 `/etc/opencodex/gateway.env` 里的 `DISPLAY`。
改这一个变量即可（两个单元都会跟着走）：

```bash
sudo sed -i 's/^DISPLAY=:99$/DISPLAY=:98/' /etc/opencodex/gateway.env
sudo systemctl restart opencodex-xvfb.service opencodex-gateway.service
```

### 4.2 如果 3737 端口已被占用

```bash
sudo sed -i 's/^PORT=3737$/PORT=13739/' /etc/opencodex/gateway.env
sudo systemctl restart opencodex-gateway.service
```

## 5. 第四步：配置

两个文件都是 conffile，升级不会覆盖你的改动。

### 5.1 `/etc/opencodex/gateway.env`（进程环境）

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

### 5.2 `/etc/opencodex/config.yaml`（站点配置）

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

改完重启：

```bash
opencodex-gateway restart
```

`*.example.com` 只匹配子域，不匹配 `example.com` 本身；也可以写环境变量 `OPENCODEX_BRAND_NAME` 覆盖品牌名
（优先级：环境变量 > config.yaml > 默认 `OpenCodex`）。

**模型流量不在拦截范围内**：它由官方 app-server 子进程直接发往本机代理，不经过浏览器出站通道，
所以不要在 `network.block` 里写模型服务域名。

## 6. 第五步：启动器 `opencodex-gateway`

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
opencodex-gateway version
```

不带参数等价于 `status`。桌面环境也可以直接点应用菜单里的 **OpenCodex**。

## 7. 验证判据（逐条都要过）

```bash
# 1) 服务在跑，且没有反复重启
systemctl is-active opencodex-gateway.service opencodex-xvfb.service   # active active
systemctl is-enabled opencodex-gateway.service                          # enabled
systemctl show -p NRestarts --value opencodex-gateway.service           # 0

# 2) 健康检查与站点品牌
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3737/healthz          # 200
curl -s http://127.0.0.1:3737/ | grep -oE '<title>[^<]*</title>'                  # <title>wdev</title>
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
```

浏览器侧（可选，需要一台能访问该网关的机器）：打开页面确认
**左下角账号名与账号菜单标题是品牌名**、**帮助菜单里没有「新功能/帮助」**、**账号菜单里没有「显示宠物」**。

## 8. 升级与卸载

```bash
# 升级：重装新包即可，conffile 会保留并在 /etc/opencodex 留 .dpkg-dist 供对比
sudo dpkg -i release/opencodex_2.3.0_amd64.deb
diff /etc/opencodex/gateway.env /etc/opencodex/gateway.env.dpkg-dist

# 卸载（保留配置与状态）
sudo dpkg -r opencodex

# 彻底清除（连 /var/lib/opencodex、/var/log/opencodex 与服务账户一起删）
sudo dpkg -P opencodex
```

`prerm` 会先停服务，避免删到正在运行的文件；`postrm purge` 负责清目录与账户。

## 9. 故障排查

### 服务起不来，日志在哪

```bash
opencodex-gateway logs 200
journalctl -u opencodex-gateway -n 200 --no-pager
sudo tail -100 /var/log/opencodex/gateway.log
```

### `Cannot open display`

`opencodex-xvfb.service` 没起来，或 `DISPLAY` 与它的显示号不一致。

```bash
systemctl status opencodex-xvfb --no-pager
pgrep -a Xvfb                      # 确认显示号，:99 被占用就改成 :98
```

### Electron 直接退出 / 白屏

确认 `/etc/opencodex/gateway.env` 里有 `OPENCODEX_HEADLESS_ELECTRON=1`。
没有它时不会追加 `--no-sandbox --headless --disable-gpu`，服务器上 Chromium 会 FATAL 退出。

### 提示找不到官方运行时

`CODEX_DESKTOP_APP_PATH` / `CODEX_DESKTOP_EXECUTABLE_PATH` 与第 2 步实际路径不一致。
注意路线 A 指向 `app.asar` 文件，路线 B 指向解包目录。

### 端口冲突

```bash
ss -ltnp | grep -E ':(3737|10101)'   # 10101 是 fork 代理，与网关无关
```

### 装了以后执行的却是别的程序

`which -a opencodex` 可能同时列出 npm 全局的 fork 代理 CLI。本包的命令是 `opencodex-gateway`，不会冲突。

## 10. 包内结构（对照）

```text
/opt/opencodex/
  gateway/{main.cjs,dev,runner,runtime,dist}   应用本体（dist 为构建产物）
  web-shell/                                   前端壳与内置 Provider 脚本
  launcher/                                    桌面启动器
  shared/                                      版本号等共享模块
  node_modules/                                生产依赖闭包（由 pnpm 生成）
  run-gateway.sh                               systemd ExecStart 包装脚本
  VERSION                                      包版本
/usr/bin/opencodex-gateway                     启动器
/usr/share/applications/opencodex.desktop      桌面入口
/usr/share/icons/hicolor/512x512/apps/opencodex.png
/lib/systemd/system/opencodex-gateway.service
/lib/systemd/system/opencodex-xvfb.service
/etc/opencodex/gateway.env                     conffile
/etc/opencodex/config.yaml                     conffile
```

## 11. 重新打包时要改的文件

| 目的 | 文件 |
|---|---|
| 依赖声明、描述 | `packaging/linux/debian/control.in` |
| 服务定义（顺序、权限、重启策略） | `packaging/linux/systemd/*.service` |
| 默认环境与站点配置 | `packaging/linux/etc/*` |
| 启动器命令 | `packaging/linux/bin/opencodex-gateway` |
| 安装/卸载钩子 | `packaging/linux/debian/{postinst,prerm,postrm}` |
| 打包流程与校验 | `packaging/linux/build-deb.sh` |
