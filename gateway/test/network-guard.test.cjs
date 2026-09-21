const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PROVIDER_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "web-shell", "internal", "providers", "codex-network-guard.js"),
  "utf8"
);
// bridge polyfill 是 Statsig initialize 完整 payload 的提供方（内层 fetch 包装 + 全局钩子），
// 本文件需要它来校验两层拦截之间的源码级契约。
const BRIDGE_POLYFILL_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "web-shell", "internal", "providers", "codex-bridge-polyfill.js"),
  "utf8"
);
const STATIC_ASSETS_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "gateway", "runtime", "http", "static-assets.cjs"),
  "utf8"
);
const CATALOG_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "gateway", "src", "modification", "catalog.ts"),
  "utf8"
);
const BROWSER_HOST_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "web-shell", "src", "modification-browser-host.ts"),
  "utf8"
);
const { createStaticAssetService } = require("../runtime/http/static-assets.cjs");
const { messagesForLocale } = require("../../shared/i18n/index.cjs");

const POINT_ID = "web.runtime.network.guard";
const PROVIDER_KEY = "network-guard";
const GUARD_URL_PATH = "/codex-network-guard.js";
const I18N_KEY = "web.runtimeCompatibility.point." + POINT_ID + ".description";
const NATIVE_BEACON_RESULT = "native-beacon-result";
const NEWLINE = String.fromCharCode(10);

/** 可控计时器：验证 XHR 模拟响应确实被推迟到 send 返回之后。 */
function createScheduler() {
  let nextId = 1;
  const timers = new Map();
  const api = {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  return {
    api,
    timers,
    capture() {
      return {
        setTimeout: (callback, delay) => api.setTimeout(callback, delay),
        clearTimeout: (id) => api.clearTimeout(id),
      };
    },
    flush() {
      const pending = Array.from(timers.values());
      timers.clear();
      for (const timer of pending) timer.callback();
    },
  };
}

/** 按给定的 network 配置装配一个假浏览器环境并安装 Provider。 */
function createHarness(network) {
  const calls = { fetch: [], open: [], send: [], beacon: [] };

  class FakeXHR {
    constructor() {
      this.listeners = new Map();
      this.events = [];
    }
    open(method, url) {
      calls.open.push({ target: this, method, url });
    }
    send(body) {
      calls.send.push({ target: this, body });
    }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
    }
    removeEventListener(type, handler) {
      const handlers = this.listeners.get(type);
      if (handlers) handlers.delete(handler);
    }
    dispatchEvent(event) {
      this.events.push(event.type);
      for (const handler of Array.from(this.listeners.get(event.type) || [])) {
        handler({ type: event.type, target: this });
      }
      return true;
    }
  }

  // 复刻浏览器只读 IDL 形状：实例直接赋值会被静默忽略，
  // 才能证明 Provider 的 defineProperty 覆盖真的生效。
  const readonlyProperties = [
    ["status", 0],
    ["statusText", ""],
    ["response", null],
    ["responseText", ""],
    ["readyState", 0],
  ];
  for (const entry of readonlyProperties) {
    Object.defineProperty(FakeXHR.prototype, entry[0], {
      configurable: true,
      get: () => entry[1],
    });
  }

  const nativeBeacon = (url, data) => {
    calls.beacon.push({ url, data });
    return NATIVE_BEACON_RESULT;
  };
  const nativeFetch = (input, init) => {
    calls.fetch.push({ input, init });
    return Promise.resolve({ native: true });
  };

  const scheduler = createScheduler();
  const scope = {
    generation: 9,
    emits: 0,
    owned: [],
    effects: { primary: { emit: () => { scope.emits += 1; } } },
    own(dispose) {
      scope.owned.push(dispose);
      return () => {
        const index = scope.owned.indexOf(dispose);
        if (index >= 0) scope.owned.splice(index, 1);
      };
    },
  };

  const window = {
    fetch: nativeFetch,
    XMLHttpRequest: FakeXHR,
    navigator: { sendBeacon: nativeBeacon },
    location: { href: "https://chatgpt.com/workspace" },
  };
  window.__CODEX_WEB_CONFIG__ = { network };
  window.__OpenCodexAdapterHost = { scheduler: { capture: () => scheduler.capture() } };
  window.__OpenCodexCurrentProviderScope = scope;

  const sandbox = {
    URL,
    Event: class TestEvent {
      constructor(type) {
        this.type = type;
      }
    },
    Response: class TestResponse {
      constructor(body, init) {
        this.body = body;
        this.status = init && init.status;
        this.headers = init && init.headers;
      }
    },
    console,
    document: {},
    location: window.location,
    navigator: window.navigator,
    window,
    XMLHttpRequest: FakeXHR,
  };

  return {
    FakeXHR,
    calls,
    nativeFetch,
    nativeBeacon,
    scheduler,
    timers: scheduler.timers,
    scope,
    window,
    install() {
      vm.runInNewContext(PROVIDER_SOURCE, sandbox);
    },
  };
}

test("blocked fetch is answered locally with a 200 JSON response", async () => {
  const harness = createHarness({ blockedHosts: ["statsigapi.net"], allowedHosts: [], configured: true });
  harness.install();
  // 安装完成只代表 ready，没有真实拦截流量时不上报命中。
  assert.equal(harness.scope.emits, 0);

  const response = await harness.window.fetch("https://statsigapi.net/v1/events", { method: "POST" });
  assert.equal(harness.calls.fetch.length, 0, "blocked url must not reach the native fetch");
  assert.equal(response.status, 200);
  assert.equal(response.body, "{}");
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(harness.scope.emits, 1, "each blocked request reports one hit");
});

test("the Statsig initialize endpoint keeps a parseable payload past the guard", async () => {
  // 与 241.t 站点配置同形状：*.chatgpt.com 管子域，chatgpt.com 管主域（通配不匹配主域）。
  const harness = createHarness({ blockedHosts: ["*.chatgpt.com", "chatgpt.com"], allowedHosts: [], configured: true });
  // 模拟内层 bridge polyfill 暴露的 payload 构造器：SDK 解析 initialize 响应需要
  // has_updates / feature_gates 等字段，裸 "{}" 会触发 "Failed to parse Response"。
  const fullPayload = {
    has_updates: true,
    feature_gates: { some_gate: { name: "some_gate", value: true, rule_id: "gateway_override" } },
    dynamic_configs: {},
    layer_configs: {},
  };
  harness.window.__OpenCodexStatsigInitializeFallback = () => fullPayload;
  harness.install();

  const initializeUrl = "https://ab.chatgpt.com/v1/initialize?client=web";

  // fetch 通道：命中 block 但属于 initialize 端点时必须透传回内层实现
  // （polyfill 本地合成完整 payload，不出网），而不是回裸 "{}"。
  const fetchResponse = await harness.window.fetch(initializeUrl);
  assert.equal(fetchResponse.native, true, "initialize fetch must pass through to the inner implementation");
  assert.equal(harness.calls.fetch.length, 1, "initialize fetch must reach the inner fetch wrapper");
  assert.equal(harness.scope.emits, 0, "passthrough traffic must not report a hit");

  // XHR 通道：响应体必须取自全局 payload 构造器，保持形状合法。
  const xhr = new harness.FakeXHR();
  xhr.open("GET", initializeUrl);
  xhr.send(null);
  assert.equal(harness.calls.send.length, 0, "initialize XHR must not reach the native send");
  assert.equal(harness.scope.emits, 1, "the swallowed XHR reports one hit");
  harness.scheduler.flush();
  assert.equal(xhr.status, 200);
  assert.equal(xhr.readyState, 4);
  assert.deepEqual(JSON.parse(xhr.responseText), fullPayload, "XHR must carry the full Statsig payload");
  assert.notEqual(xhr.responseText, "{}", "initialize must never be answered with bare {}");

  // 遥测端点语义不变：SDK 只关心 200、不解析响应体，"{}" 足够。
  // 用一个明确被封、且不属于 Statsig 任何特判通道的 URL 验证既有语义不被本次修改影响。
  const telemetry = new harness.FakeXHR();
  telemetry.open("POST", "https://chatgpt.com/ces/v1/rgstr");
  telemetry.send("payload");
  harness.scheduler.flush();
  assert.equal(telemetry.status, 200);
  assert.equal(telemetry.responseText, "{}", "telemetry endpoints keep the bare {} contract");

  // 全局钩子缺失（异常装配顺序）时 XHR 回退 "{}" 保底，保证 provider 不因缺依赖而崩溃。
  // 用独立 harness 验证，避免在同一实例上二次 install 造成 send 双重包装干扰计数。
  const degraded = createHarness({ blockedHosts: ["*.chatgpt.com", "ab.chatgpt.com"], allowedHosts: [], configured: true });
  degraded.install();
  const degradedXhr = new degraded.FakeXHR();
  degradedXhr.open("GET", initializeUrl);
  degradedXhr.send(null);
  degraded.scheduler.flush();
  assert.equal(degradedXhr.status, 200);
  assert.equal(degradedXhr.responseText, "{}", "missing fallback hook degrades to the mock body");
});

test("the bridge polyfill exposes the initialize payload builder for the network guard", () => {
  // 源码级契约：polyfill 必须把构造器挂到命名空间全局，guard 必须消费它做 initialize 特判，
  // 否则两层包装叠起来会用裸 "{}" 应答 initialize，SDK 会持续解析失败。
  assert.ok(
    BRIDGE_POLYFILL_SOURCE.includes(
      "w.__OpenCodexStatsigInitializeFallback = buildStatsigInitializeResponse"
    ),
    "polyfill must expose the payload builder on the namespace global"
  );
  assert.ok(PROVIDER_SOURCE.includes("isStatsigInitializeUrl"), "guard must recognize the initialize endpoint");
  assert.ok(
    PROVIDER_SOURCE.includes("__OpenCodexStatsigInitializeFallback"),
    "guard must consume the exposed payload builder"
  );
});

test("unblocked fetch passes through to the native implementation", async () => {
  const harness = createHarness({ blockedHosts: ["statsigapi.net"], allowedHosts: [], configured: true });
  harness.install();

  const passthroughUrls = [
    "https://api.openai.com/v1/models",
    "https://statsigapi.net.evil.example/v1/events",
    "/api/thread",
  ];
  for (const url of passthroughUrls) {
    const response = await harness.window.fetch(url);
    assert.equal(response.native, true, "passthrough url: " + url);
  }
  assert.equal(harness.calls.fetch.length, passthroughUrls.length);
  assert.equal(harness.scope.emits, 0, "passthrough traffic must not report a hit");
});

test("wildcard pattern matches subdomains only, allow list carves a hole", async () => {
  const harness = createHarness({
    blockedHosts: ["*.example.com"],
    allowedHosts: ["api.example.com"],
    configured: true,
  });
  harness.install();

  // 子域命中通配：被拦。
  await harness.window.fetch("https://cdn.example.com/x.js");
  assert.equal(harness.calls.fetch.length, 0);
  assert.equal(harness.scope.emits, 1);
  // 主域不命中 *.example.com：透传。
  await harness.window.fetch("https://example.com/x.js");
  assert.equal(harness.calls.fetch.length, 1);
  // allow 清单在被拦域族里开洞：透传。
  await harness.window.fetch("https://api.example.com/v1");
  assert.equal(harness.calls.fetch.length, 2);
  assert.equal(harness.scope.emits, 1, "allow-listed host must not report a hit");
});

test("blocked XHR is answered with a mock 200 and forwarded XHR keeps the native send", async () => {
  const harness = createHarness({ blockedHosts: ["analytics.example.com"], allowedHosts: [], configured: true });
  harness.install();

  const xhr = new harness.FakeXHR();
  const handled = [];
  xhr.addEventListener("load", () => handled.push("load"));
  xhr.open("POST", "https://analytics.example.com/collect");
  xhr.send("payload");
  assert.equal(harness.calls.send.length, 0, "blocked url must not reach the native send");
  assert.equal(harness.scope.emits, 1);
  assert.deepEqual(xhr.events, ["loadstart"]);
  assert.equal(harness.timers.size, 1, "status completion must be deferred until send returns");

  harness.scheduler.flush();
  assert.equal(xhr.status, 200);
  assert.equal(xhr.statusText, "OK");
  assert.equal(xhr.readyState, 4);
  assert.equal(xhr.responseText, "{}");
  assert.deepEqual(handled, ["load"]);

  const passthrough = new harness.FakeXHR();
  passthrough.open("GET", "https://api.example.com/v1/models");
  passthrough.send(null);
  assert.equal(harness.calls.send.length, 1, "unblocked url must use the native send");
  assert.equal(passthrough.readyState, 0);
});

test("blocked beacons report success while forwarded beacons keep the native result", () => {
  const harness = createHarness({ blockedHosts: ["*.telemetry.net"], allowedHosts: [], configured: true });
  harness.install();

  assert.equal(harness.window.navigator.sendBeacon("https://a.telemetry.net/x", "p"), true);
  // 相对 URL 按页面 origin 解析：页面在 chatgpt.com，未配置拦截该域，走原生。
  assert.equal(harness.window.navigator.sendBeacon("/track", "p"), NATIVE_BEACON_RESULT);
  assert.equal(harness.calls.beacon.length, 1);
  assert.equal(harness.scope.emits, 1, "each swallowed beacon reports one hit");

  assert.equal(
    harness.window.navigator.sendBeacon("https://example.com/x", "p"),
    NATIVE_BEACON_RESULT
  );
  assert.equal(harness.calls.beacon.length, 2);
  // 只有 a.telemetry.net 那一条命中拦截，两条透传都不该上报。
  assert.equal(harness.scope.emits, 1, "a forwarded beacon must not report a hit");
});

test("no network policy means the provider does not install at all", () => {
  const cases = [
    undefined,
    { blockedHosts: ["statsigapi.net"], allowedHosts: [], configured: false },
    { blockedHosts: [], allowedHosts: ["api.example.com"], configured: true },
  ];
  for (const network of cases) {
    const harness = createHarness(network);
    const beforeFetch = harness.window.fetch;
    const beforeOpen = harness.FakeXHR.prototype.open;
    const beforeBeacon = harness.window.navigator.sendBeacon;
    harness.install();
    assert.equal(harness.window.fetch, beforeFetch, "fetch stays native");
    assert.equal(harness.FakeXHR.prototype.open, beforeOpen, "XHR prototype stays native");
    assert.equal(harness.window.navigator.sendBeacon, beforeBeacon, "beacon stays native");
    assert.equal(harness.scope.owned.length, 0, "no policy installs no disposers");
    assert.equal(harness.scope.emits, 0);
  }
});

test("the dispose registered through own() restores the native implementations", () => {
  const harness = createHarness({ blockedHosts: ["statsigapi.net"], allowedHosts: [], configured: true });
  const originalFetch = harness.nativeFetch;
  const originalOpen = harness.FakeXHR.prototype.open;
  const originalSend = harness.FakeXHR.prototype.send;
  harness.install();
  assert.equal(harness.scope.owned.length, 1);

  harness.scope.owned[0]();
  assert.equal(harness.window.fetch, originalFetch);
  assert.equal(harness.FakeXHR.prototype.open, originalOpen);
  assert.equal(harness.FakeXHR.prototype.send, originalSend);
  assert.equal(harness.window.navigator.sendBeacon, harness.nativeBeacon);
  assert.equal(harness.window.__opencodexNetworkGuardInstalled, undefined);

  // 还原后被封域请求直接走原生通道，不再被本地吞掉。
  harness.window.fetch("https://statsigapi.net/v1/events").then((response) => {
    assert.equal(response.native, true, "restored fetch must stop swallowing");
    assert.equal(harness.calls.fetch.length, 1);
    assert.equal(harness.scope.emits, 0);
  });

  harness.install();
  assert.notEqual(harness.window.fetch, originalFetch, "reinstall must patch again");
});

test("loading the provider twice in one page generation installs a single patch", () => {
  const harness = createHarness({ blockedHosts: ["statsigapi.net"], allowedHosts: [], configured: true });
  harness.install();
  const patchedFetch = harness.window.fetch;
  harness.install();
  assert.equal(harness.window.fetch, patchedFetch);
  assert.equal(harness.scope.owned.length, 1);
});

test("the provider keeps its own match logic and stays free of CJS gateway modules", () => {
  // 浏览器端不能 require gateway 的 CJS 模块，匹配逻辑必须自包含。
  assert.ok(!PROVIDER_SOURCE.includes("require("));
  assert.ok(PROVIDER_SOURCE.includes("__opencodexNetworkGuardInstalled"));
  assert.ok(PROVIDER_SOURCE.includes("hostMatchesPattern"));
  assert.ok(PROVIDER_SOURCE.includes("modificationScope?.own?.("));
  assert.ok(PROVIDER_SOURCE.includes("modificationEffects?.primary?.emit()"));
});

test("the gateway serves the guard and registers it in the aggregated runtime bootstrap", (t) => {
  const webviewDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencodex-network-"));
  t.after(() => fs.rmSync(webviewDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(webviewDir, "index.html"),
    "<html><head><title>Codex</title></head><body></body></html>"
  );
  const service = createStaticAssetService({
    compatibilityService: null,
    getI18nSnapshot: () => ({ locale: "en-US", messages: messagesForLocale("en-US") }),
    getOfficialBundle: () => ({ webviewDir }),
  });

  assert.equal(
    path.basename(service.staticFile(GUARD_URL_PATH)),
    "codex-network-guard.js"
  );

  const res = {
    body: Buffer.alloc(0),
    headers: {},
    status: 0,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(body) {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf-8");
    },
  };
  service.serveRuntimeBootstrap({ headers: {} }, res);
  assert.equal(res.status, 200);
  const bootstrap = res.body.toString("utf-8");

  const guardIndex = bootstrap.indexOf('providers.register("' + PROVIDER_KEY + '"');
  assert.ok(guardIndex > 0, "guard must be wrapped by the provider registry");
  const groups = STATIC_ASSETS_SOURCE.slice(STATIC_ASSETS_SOURCE.indexOf("function runtimeBootstrapFileGroups"));
  const guardOrder = groups.indexOf("CODEX_NETWORK_GUARD_PATH");
  const activateOrder = groups.indexOf("OPENCODEX_MODIFICATION_ACTIVATE_PATH");
  assert.ok(guardOrder >= 0 && activateOrder > guardOrder, "guard must load before kernel activation");

  // 修改点在目录里声明一次，在骨架里绑定一次，静态资源把文件映射到 provider key。
  const declaration = '"' + POINT_ID + '"';
  const catalogLines = CATALOG_SOURCE.split(NEWLINE).filter((line) => line.includes(declaration));
  assert.equal(catalogLines.length, 1, "the point must be declared exactly once");
  assert.ok(catalogLines[0].includes("G.webNetwork"));
  assert.ok(catalogLines[0].includes("A.networkRequest"));
  const bindingLines = BROWSER_HOST_SOURCE.split(NEWLINE).filter((line) => line.includes(POINT_ID));
  assert.equal(bindingLines.length, 1, "the point must bind exactly one provider");
  assert.ok(STATIC_ASSETS_SOURCE.includes('[path.join(INTERNAL_PROVIDER_DIR, "codex-network-guard.js"), "network-guard"]'));
  assert.ok(STATIC_ASSETS_SOURCE.includes('const CODEX_NETWORK_GUARD_PATH = "' + GUARD_URL_PATH + '"'));

  // 英文必须显式给描述；zh-CN 语言包按仓库约定不承载修改点文案。
  const localeDir = path.join(REPO_ROOT, "shared", "i18n", "locales");
  const enMessages = JSON.parse(
    fs.readFileSync(path.join(localeDir, "runtime-compatibility-en-US.json"), "utf8")
  );
  assert.ok(String(enMessages[I18N_KEY] || "").trim(), "missing " + I18N_KEY + " for en-US");
});
