# 241.t 固定脚本缓存修复（版本化路径命名空间）

## 问题

`https://codex-241.ai-t.wtvdev.com/opencodex-runtime-bootstrap.js` 与
`/official-patched-v8/assets/app-initial-74b69e67976a.js` 每次刷新都全量重下，
响应头是 `cache-control: private, no-cache, must-revalidate`。静态资源本应长缓存。

## 根因（两层）

1. 网关对这两个固定脚本走校验缓存（`private, no-cache`），依赖 ETag 协商。
2. 边缘 APISIX（10.252.25.252）对 200 响应做 brotli 重压缩时会剥掉上游 ETag，
   浏览器因此无法协商缓存，每次都是全量传输。authz（235.t openresty 6443）和上游网关都正常保留 ETag。

因此缓存策略必须与 ETag 解耦，改用 URL 版本位 + `max-age`。

## 方案：内容指纹进路径

只在 query 上带 `?fp=` 不够：入口 chunk 由 `index-*.js` 以相对路径动态导入，
**相对解析只继承目录、不继承 query**，于是入口 chunk 落回 no-cache。

把指纹写进目录命名空间 `/official-patched-v8-<fp>/assets/`：

- 目录版本位是主失效位。相对动态导入天然继承同一目录，整条懒加载链路一起版本化。
- 保留 `?fp=` 作为双保险（HTML 显式引用命中更严格的 fp 分支）。
- 命中当前指纹 → `public, max-age=31536000, immutable`，并按公共缓存语义剥离 Set-Cookie。
- 指纹算不出来或版本位过期 → 退回原有 `private, no-cache, must-revalidate`，不固化旧脚本。
- 旧 `/official-patched-v8/` 前缀继续可服务（浏览器残留懒加载），保持校验语义。
- 补丁缓存键用规范前缀（`canonicalizeVersionedPatchedPath`），避免每个指纹各存一份 9.8MB 主包。
- bootstrap 的 ETag 改为强校验器，跨编码一致。

指纹输入：补丁修订号、网关版本、官方 bundle 的 version/build、webviewDir mtime、
品牌名、远端下载文案、`static-assets.cjs` 与 `config.cjs` 自身散列。任一变化即翻转 URL。

## 判据（2026-09-21 实测）

| 检查 | 结果 |
|---|---|
| 网关直连 bootstrap | `public, max-age=31536000, immutable` + 强 ETag |
| 经 APISIX + authz 公网访问 bootstrap | `public, max-age=31536000, immutable`，无 set-cookie |
| 经 APISIX 访问入口 chunk | `public, max-age=31536000, immutable` |
| HTML 内引用 | 24 处全部 `/official-patched-v8-oh00FvQwF7/assets/`，裸前缀 0 处 |
| 真实浏览器二次回访 | 首访 transferSize 2502307/182935/12360；回访全部 0 |
| `pnpm build:gateway` | 退出码 0 |
| `pnpm test` | 508 通过 / 6 失败，失败恰为既有基线 |

## 部署

只替换 5 个文件，不改配置，走 `/nas2/tmp/deploy-v2ns.sh`（备份目录
`/opt/ocx-stack/gateway/.bak-v2ns-<ts>`）：

```
gateway/runtime/http/static-assets.cjs
gateway/test/static-assets.test.cjs
gateway/test/network-guard.test.cjs
web-shell/internal/providers/codex-bridge-polyfill.js
web-shell/internal/providers/codex-network-guard.js
```

241.t md5：`static-assets.cjs` = `bbdd6614c0fed508d748207224f4867b`。

### 重启注意

3737 上的 Web 网关是 **`ocx-stack-gateway.service`**，不是 `ocx-stack-proxy.service`
（后者是 10101 的 opencodex fork 代理）。两者都叫 ocx-stack，restart 前者才会换掉 3737 的代码。
校验语法要用 bundle 自带的 `/opt/ocx-stack/node/bin/node`，系统 node 版本过旧会误报语法错误。

