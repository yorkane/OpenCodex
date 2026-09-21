# 品牌替换 + 出站域名拦截补丁（241.t 部署与验证）

> 更新日期：2026-09-21（UTC）　适用机器：241.t（Ubuntu 22.04，OpenCodex 栈已运行）
> 本文覆盖两部分：**改了什么**、**怎么部署到 241.t 并验证**（每条都给出判据与实测输出）。

## 0. 需求与实现总览

需求两条：

1. 把界面上显示的 `codex` / `chatgpt` / `openai` 文案与标识，换成可配置品牌名（示例 `wdev`）。
2. 整理所有对外请求域名（**模型服务除外**），允许按配置拦截指定域名，避免信息泄露。

实现方式：在 **config.yaml 里新增 `brand` 与 `network` 两个块**，在 gateway 的每个出站/渲染点统一读取并应用。

配置示例（`config.example.yaml`，241.t 实际写在 `/etc/ocx-stack/gateway-config.yaml`）：

```yaml
auth:
  password: "your-password"      # 原有字段，保持不变

brand:
  name: "wdev"                   # 界面品牌名；不配则保持历史默认 OpenCodex

network:
  block:                         # 命中即本地拦截，不发真实请求
    - "*.chatgpt.com"
    - "chatgpt.com"
    - "*.openai.com"
    - "*.oaiusercontent.com"
    - "*.statsig.com"
    - "statsigapi.net"
  allow: []                      # 在被拉黑的域族里开洞（优先级高于 block）
```

- `*.example.com` 只匹配子域，**不匹配** `example.com` 本身（glob 语义）。
- 取值优先级：环境变量 `OPENCODEX_BRAND_NAME` > config.yaml > 默认 `OpenCodex`。
- 解析器 `gateway/runtime/core/site-config.cjs` 是手写 YAML 子集（本仓库不引 yaml 依赖），
  任何解析异常都回落到默认值，**不会因为配置写坏导致 gateway 起不来**。

### 生效位置（拦截/替换点）

| 层 | 文件 | 作用 |
|---|---|---|
| 配置解析 | `gateway/runtime/core/site-config.cjs`（新增） | 读 `brand`/`network`，导出 `getSiteConfig` / `isBlockedUrl` |
| Electron main | `gateway/runtime/electron/official-net-fetch-statsig-hook.cjs` | 覆写 `electron.net.fetch`：命中清单回本地 200 `{}` |
| IPC 中继 | `gateway/runtime/ipc/official-runtime.cjs`（`maybeHandleConfiguredNetworkBlockNoop`） | renderer→main 的 fetch 委托按清单兜底 |
| 浏览器 | `web-shell/internal/providers/codex-network-guard.js`（新增 Provider） | `fetch` / `XHR` / `sendBeacon` 三通道按清单拦截 |
| 浏览器文案 | `web-shell/internal/providers/codex-brand-text.js`（新增 Provider） | 已渲染 DOM 的品牌词与 `document.title` |
| 官方 HTML | `gateway/runtime/http/static-assets.cjs` `patchHtmlBrand` | 官方 `<title>` 与 PWA meta |
| 登录页/PWA | 同文件 `createWebShellIndexResponse` / `patchPwaManifestBrand` | 登录壳标题、`manifest.webmanifest` |
| 启动器 | `launcher/main.cjs` / `launcher/renderer.js` / `launcher/index.html` | 窗口标题、托盘提示、品牌位、页签标题 |
| i18n | `shared/i18n/index.cjs` `withBrandName` | 文案表里的产品名统一替换 |

### 新增修改点（骨架目录 105 → 108）

| id | 组 | 含义 |
|---|---|---|
| `static.cache.renderer.html.brand` | renderer-resources | 官方 HTML 品牌文案改写 |
| `web.runtime.network.guard` | web-network | 浏览器三通道按清单拦截出站请求 |
| `web.runtime.dom.brand-text` | renderer-ui | 已渲染界面品牌文字替换 |

`web.runtime.*` 的点必须各自绑定一个浏览器 Provider，否则骨架装配层直接抛错，
因此 `codex-network-guard.js` / `codex-brand-text.js` 与上表两点是一一对应的。

## 1. 关键设计决策（避免踩坑）

1. **默认不改变历史行为**：未配置 `brand.name` 时，其它文案保持不变；只有官方渲染产物里的
   官方品牌词会被换成默认产品名（这正是需求要的"不显示 codex/openai"）。
2. **不改会话正文**：`codex-brand-text.js` 通过 `closest()` **整棵跳过**消息 markdown、用户气泡、
   输入框、代码块等容器（`[data-markdown-text-style]`、`[data-user-message-bubble]`、
   `pre`/`code`/`script`/`style`/`template`、`contenteditable`）。否则用户正文里出现 "Codex" 会被改坏。
3. **只做窄替换**：品牌词按词边界替换，且只碰 `alt`/`title`/`aria-label` 三个用户可见属性；
   `--codex-*` CSS 变量、`data-codex-*` 属性、class 名、`codex-sandbox://` 协议、i18n key、
   chunk 导入路径一律不动。
4. **模型服务不在拦截范围**：模型流量走 `ocx-stack-proxy`（127.0.0.1:10101），
   不经浏览器/renderer 的 fetch 通道，因此清单不会误伤模型路由。
5. **Provider 必须用共享宿主能力**：项目边界检查禁止 Provider 内自建 `MutationObserver`
   或裸定时器，必须走 `window.__OpenCodexAdapterHost.dom.observe` 与 `scheduler.capture()`。
6. **配置写回只改一行**：`launcher/main.cjs` 的 `writeAuthConfig` 原本整文件覆盖 config.yaml，
   会把新增的 `brand`/`network` 块抹掉；已改为只替换 `password` 行。

## 2. 部署到 241.t

补丁面 = 相对已部署基线变化的 27 个源文件 + `gateway/dist`（生成物，未入库，运行时直接 require）。
`gateway/dist` 必须在构建机产出后整树同步，241.t 的系统 `node` 是 v12，读不了新 dist，
实际运行用的是 `/opt/ocx-stack/node/bin/node`（v24）。

```bash
# 【构建机】构建并暂存
cd /home/aigc/ChatGPT/OpenCodex
pnpm --config.verify-deps-before-run=false run build
git checkout -- pnpm-workspace.yaml      # pnpm 会自动改这个文件，必须还原
# 暂存到 /nas2（两机共享），脚本见 /data/tmp/stage_deploy.sh
bash /data/tmp/stage_deploy.sh
# → 48 个文件发布到 /nas2/tmp/ocx-brand-patch

# 【241.t】先备份（回滚用）
ssh 241.t 'sudo mkdir -p /opt/ocx-stack/gateway.bak-brand-$(date +%Y%m%d-%H%M%S)'
# 按清单逐文件拷进 /opt/ocx-stack/gateway/ 树（脚本 /data/tmp/apply3.sh）
ssh 241.t 'bash /data/tmp/apply3.sh'
# 判据：48 个文件 md5 与 /nas2 暂存区逐个一致（脚本内已校验），属主必须是 aigc

# 【241.t】写配置
sudo tee /etc/ocx-stack/gateway-config.yaml   # brand/network 见 §0
sudo systemctl restart ocx-stack-gateway
```

**判据**：`curl -s -o /dev/null -w '%{http_code}' localhost:3737/healthz` = 200，
`systemctl show -p NRestarts --value ocx-stack-gateway` = 0。

## 3. 验证结果（2026-09-21 实测）

### 3.1 品牌（服务端产物）

```
$ curl -s localhost:3737/ | grep -oE '<title>[^<]*</title>|application-name" content="[^"]*"|apple-mobile-web-app-title" content="[^"]*"'
<title>wdev</title>
application-name" content="wdev"
apple-mobile-web-app-title" content="wdev"

$ curl -s localhost:3737/manifest.webmanifest
name= wdev  short_name= wdev  start_url= /  icons= 2

$ curl -s localhost:3737/codex-web-config.js | grep -oE 'brand: \{[^}]*\}'
brand: {"name":"wdev","source":"config","configured":true}
```

### 3.2 品牌（真实浏览器，playwright 经 SSH 隧道访问 241.t:3737）

```
document.title            -> "wdev"        # 官方标题模板 "ChatGPT - {title}" 已被替换
mode button aria-label    -> "Switch mode, current mode: wdev"
__opencodexBrandTextInstalled -> true
__opencodexNetworkGuardInstalled -> true
```

### 3.3 出站域名拦截

浏览器内发起请求（页面 fetch），与**同一时刻的真实网络**对照：

| 目标 | 页面 fetch 结果 | 真实网络（curl，无补丁） | 结论 |
|---|---|---|---|
| `https://ab.chatgpt.com/v1/initialize` | **200**，`content-type: application/json`，body `{}` | 241.t 上 `http=000`（连不通）；本机 `403 text/html` | 命中拦截，回本地 mock |
| `https://api.statsigapi.net/v1/log_event` | `NETERR: Failed to fetch` | `http=000` | 拦截生效（未出网） |
| `https://api.github.com/` （不在清单） | `NETERR: Failed to fetch` | 本机 200 | 透传真实网络（未误伤） |

gateway 日志出现配置驱动的拦截标记（旧版只有固定的 Statsig 短路）：

```
$ sudo tail -n 20 /var/log/ocx-stack-gateway.log | grep -aoE '\[(network-guard|statsig-net-fetch)\] [a-z_]+' | sort | uniq -c
      3 [network-guard] net_fetch_blocked_by_config
```

被拦截的目标域名在日志中可见（`https://chat.openai.com`），说明清单确实拦到了非 Statsig 的域名。

### 3.4 骨架诊断

```
$ curl -s localhost:3737/api/opencodex/runtime-compatibility | python3 ...
total points: 108
static.cache.renderer.html.brand -> healthy
web.runtime.dom.brand-text      -> healthy
web.runtime.network.guard       -> healthy
```

浏览器产生真实流量后，这三个点都从「已就绪」进入「已命中」（`exercise.status = active`），
说明补丁不只装了脚本，而是真的在执行：

```
static.cache.renderer.html.brand -> healthy  exercise={"status":"active","hitCount":8}
web.runtime.dom.brand-text       -> healthy  exercise={"status":"active","hitCount":1}
web.runtime.network.guard        -> healthy  exercise={"status":"active","hitCount":1}
```

### 3.5 单测

`node --test`（487 项）：**481 通过 / 6 失败**；6 条失败为 origin/main 既有失败
（macOS 候选路径、scanner 回退、Windows Appx、plugin-config、诊断页 locale、兼容页 locale），
与本次改动无关。新增测试：`site-config.test.cjs`、`network-guard.test.cjs`、`brand-text.test.cjs`
以及 `static-assets.test.cjs` / `official-runtime.test.cjs` 内的品牌与拦截用例。

## 4. 回滚

```bash
# 1) 恢复补丁面文件
BAK=$(cat /opt/ocx-stack/.brand-patch-backup)
cd "$BAK" && find . -type f | while read -r rel; do sudo cp -a "$BAK/$rel" "/opt/ocx-stack/gateway/$rel"; done
# 2) 恢复配置
sudo cp -a /etc/ocx-stack/gateway-config.yaml.bak-brand-* /etc/ocx-stack/gateway-config.yaml
# 3) 重启
sudo systemctl restart ocx-stack-gateway
```

## 5. 外部请求域名清单（「整理」交付物）

下表是补丁落地前项目里所有会出网的域名（模型服务单列，按需求排除在拦截范围外）。
「现状」列 = 补丁前的行为；「本次处理」列 = 现在的行为。

| 域名 / 协议 | 发起层 | 用途 | 补丁前 | 本次处理 |
|---|---|---|---|---|
| `ab.chatgpt.com` `/v1/initialize` | Electron main / renderer / gateway IPC | Statsig 功能开关初始化 | 已硬编码短路 | 保留 + 纳入清单 |
| `ab.chatgpt.com` `/v1/sdk_exception` | Electron main / gateway IPC | Statsig SDK 异常上报 | 已短路 | 保留 + 纳入清单 |
| `chatgpt.com` `/ces/v1/rgstr`、`/ces/v1/log_event` | renderer / Electron main / gateway IPC | CES 遥测上报 | 已短路 | 保留 + 纳入清单 |
| `chatgpt.com/wham/statsig/bootstrap` | renderer IPC | 登录后 Statsig 初始化 | **仅 web 侧短路，Electron 侧会真实出网** | 纳入清单，三处统一拦截 |
| `chatgpt.com/backend-api/*`、`/aip/connectors/<id>/logo` | Electron main IPC | 官方业务 API、connector 图标 | **全部透传真实出网** | 纳入清单，命中即本地拦截 |
| `*.oaiusercontent.com`（CSP 中的 `codex-sandbox://`） | renderer | 沙箱资源域 | 透传 | 纳入清单 |
| `*.openai.com`、`cdn.openai.com` | Electron main / renderer | CDN、账号相关 | 透传 | 纳入清单 |
| `*.statsig.com`、`statsigapi.net` | renderer XHR/Beacon / Electron main | Statsig SDK 控制面 | XHR/Beacon 已本地 mock，fetch 侧透传 | 纳入清单，三通道统一 |
| `sentry-ipc://`（私有协议，非域名） | renderer | Sentry IPC | web 侧空响应兜底 | 保持（非 http(s)，清单不拦） |
| `api.github.com/repos/RyensX/OpenCodex/releases/latest` | launcher main | 启动器更新检查 | 透传（失败不阻断） | **未纳入**：属启动器自身更新功能，与页面信息泄露无关 |
| `fonts.googleapis.com`、`fonts.gstatic.com` | launcher renderer | 启动器字体 | 透传（失败回退系统字体） | **未纳入**：仅启动器本地界面字体 |
| `github.com` | launcher / web-shell | 用户点击的外链 | 用户主动点击 | 保持 |
| 模型服务（`llm-248`、`minimax-cn`、`zai`、`217` 等） | `ocx-stack-proxy`（127.0.0.1:10101） | LLM 推理请求 | 正常 | **按需求排除在拦截范围外** |

关键点：模型流量由官方 app-server 子进程直接发往 `ocx-stack-proxy`，
不经过浏览器 `window.fetch` / XHR / Beacon，也不经过 `electron.net.fetch` 钩子，
因此清单不会误伤模型路由；实测未配置任何域名时该 Provider 完全不安装，零额外开销。

配置建议（按需增删）：

```yaml
network:
  block:
    - "*.chatgpt.com"
    - "chatgpt.com"
    - "*.openai.com"
    - "*.oaiusercontent.com"
    - "*.statsig.com"
    - "statsigapi.net"
  allow: []
```


## 6. 已知限制

- 只做**文字品牌**：官方启动动画的 blossom SVG 图形、`OpenAI Sans` 字体、以及
  `assets/` 里以 `codex-*`/`chatgpt-*` 命名的图片文件未替换（属 logo 级视觉改动，超出本次需求）。
- 官方 JS chunk 内部的功能常量（如品牌请求头 `ChatGPT-Account-Id`、产品模式比较）刻意保留，
  它们不是界面文案，改坏会破坏 API 身份。
- 订阅名（`ChatGPT Pro`/`Plus`/`Go` 等）未替换，属官方计费体系文案，保持原样。
