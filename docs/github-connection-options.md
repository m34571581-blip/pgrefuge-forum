# GitHub 连接方式的顺畅度方案

问题：现状是「粘贴 PAT」，用户要去 GitHub 设置页手动造令牌、复制、粘贴 —— 流程断点多，流失必然高。

目标：点一下 → 跳转授权 → 自动回到站点完成绑定。

---

## 一、先把可行路径穷尽（全部实测，非推测）

### 实测数据

| # | 事实 | 证据 |
|---|---|---|
| 1 | `api.github.com/graphql` 有 `ACAO: *` | curl 响应头 |
| 2 | `api.github.com` REST 有 `ACAO: *` | curl 响应头 |
| 3 | `github.com/login/device/code` **无 ACAO 头** | curl + Playwright 双验证：`TypeError: Failed to fetch` |
| 4 | `github.com/login/oauth/access_token` **无 ACAO 头** | 同上 |
| 5 | `api.github.com` 上**没有** OAuth 端点 | `/login/device/code`、`/authorizations`、`/applications/tokens` 全 404 |
| 6 | **Web OAuth Flow 换 token 必须带 `client_secret`** | 不带 → `incorrect_client_credentials`；带错 → 同样错误 |
| 7 | **Device Flow 换 token 不需要 `client_secret`** | 不带 → `authorization_pending`（进入正常流程） |
| 8 | WorkBuddy 云服务的透传代理**仅小程序端可用** | `miniProgramFetch` 走 `wx.request`；Web 端 SDK 无代理（0 个 proxy 相关符号） |
| 9 | WorkBuddy 云服务 OAuth relay 的 provider 是**平台级固定**的 | 实测只支持 `google` / `wechat`，`github` → 400 |

第 6、7 两条来自 GitHub 官方文档：
> `client_secret` — "Required **unless the token was generated using the device flow**"
> `client_secret` "is not needed for the device flow."

---

## 二、路径穷举

| 方案 | 用户操作 | 需要服务端 | 流畅度 | 可行性 |
|---|---|---|---|---|
| A. 粘贴 PAT（现状） | 造令牌→复制→粘贴 | 否 | ⭐⭐ | 已上线 |
| B. **Device Flow + 中转** | 点按钮→输 8 位码→完成 | **是** | ⭐⭐⭐⭐ | **可行** |
| C. Web OAuth + PKCE + 中转 | 点按钮→跳转授权→自动回调 | **是** | ⭐⭐⭐⭐⭐ | **可行，但中转须持 secret** |
| D. WorkBuddy 云服务做中转 | 同 B/C | — | — | ❌ 第 8、9 条 |
| E. GitHub Actions 做中转 | — | — | — | ❌ 非常驻 + 匿名用户无写权限 |
| F. 纯前端（无中转） | — | — | — | ❌ 第 3、4、6 条 |

**结论**：B 和 C 都可行，都需要中转。
C（Web OAuth）更顺，但中转必须持有 `client_secret`；
B（Device Flow）中转**不持有机密**，只转发两个 POST。

---

## 三、推荐方案：C + B 混合，中转零机密

### 关键洞察

**把「换 token」这一步放在用户自己的 GitHub 页面里完成**，就不需要中转了 —— 但 GitHub 不允许。

所以只能中转。既然要中转，就让它**最简单**：

```js
// Cloudflare Worker，全文就这些
export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url)
    // 只允许两个路径
    if (pathname === '/device/code' || pathname === '/device/token') {
      const body = await req.text()
      const r = await fetch('https://github.com/login' + pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body
      })
      return new Response(await r.text(), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }
    return new Response('not found', { status: 404 })
  }
}
```

- **不存任何东西**：无状态纯转发
- **不持有机密**：Device Flow 只需公开的 `client_id`
- 30 行代码，Cloudflare Workers 免费额度足够

### 用户体验（Device Flow）

```
点「绑定 GitHub」
  → 弹出 8 位码 + 一键打开的授权链接
  → 用户在 GitHub 页面点「Authorize」
  → 页面自动跳回站点 → 绑定完成
```

用户操作：**2 次点击**（对比现状的「打开设置页→找到令牌生成器→填表→勾权限→生成→复制→切回粘贴」约 10+ 步）。

### 用户体验（Web OAuth，若中转愿意持 secret）

```
点「绑定 GitHub」→ 跳转 GitHub 授权页 → 点「Authorize」→ 自动回站点
```

用户操作：**1 次点击**。但中转需持 `client_secret`，且需注册 OAuth App 并配置 callback URL。

---

## 四、为什么 CORS 是死结

浏览器安全模型：`github.com` 不返回 `Access-Control-Allow-Origin`，
所以 JS 发出的跨域请求**响应不可读**。

这不是配置问题，是 GitHub 的服务端策略 —— 没法在前端绕过。
唯一出路是让**服务端**发那个请求。

（`mode: 'no-cors'` 能发出请求但读不到响应体，对 OAuth 无用；
JSONP 不支持；`api.github.com` 上没有 OAuth 端点。）

---

## 五、落地清单

### 需要用户提供的

1. **注册一个 GitHub OAuth App**
   - Settings → Developer settings → OAuth Apps → New
   - Homepage / Callback URL 填站点地址（Web OAuth 需要）
   - 拿到 `client_id`（公开）與 `client_secret`（机密）
2. **部署中转**（二选一）
   - Cloudflare Worker（30 行，免费）
   - 或直接用 Worker 的现成模板

### 我负责实现的

1. `site/github-bind.js` 补 Device Flow 的 UI 流程（已有接口骨架）
2. `site/index.html` 的绑定区改为「点按钮 → 显示码 → 轮询」
3. 保留 PAT 方式作为兜底（中转没配好时自动降级）
4. 中转 Worker 源码 + 部署说明写进 `docs/`

---

## 六、中转的降级策略

中转可能挂（Worker 超额、用户忘部署、GitHub 改策略）。
所以 PAT 方式**必须保留**，并在检测到中转不可用时自动显示。

这也是为什么现有实现的 `github-bind.js` 把两种方式抽象成同一个
`bindWithToken()` —— 加 Device Flow 不需要改 UI 与发帖逻辑。

---

## 六、GitHub Actions 做中转的可行性（2026-11-06 实测复核）

结论：**不可行**。不是因为技术上做不到，而是因为**没有一条「站点能读、别人读不到」的回传通道**。

### 逐项实测

| 环节 | 实测结果 |
|---|---|
| `POST /repos/{owner}/{repo}/dispatches`（匿名） | **401** Requires authentication |
| `POST /actions/workflows/{id}/dispatches`（匿名） | **401** Requires authentication |
| `POST /issues`（匿名建 issue 触发 workflow） | **401** Requires authentication |
| `GET /actions/runs`（匿名读 run 状态） | 200 —— 公开可读 |
| `GET /actions/artifacts`（匿名读 artifact 列表） | 200 —— 公开可读 |
| `GET /actions/artifacts/{id}/zip`（匿名下载内容） | **401** Requires authentication |

→ **触发 workflow 必须先有 token**，而 token 正是我们要获取的东西 → 循环依赖，死结。

### 回传通道逐个排除

| 通道 | 站点能读 | 别人能读 | 结论 |
|---|---|---|---|
| 写公开分支 / commit | ✅ | ✅ | ❌ token 泄露 |
| issue 评论 / Discussion 正文 | ✅ | ✅ | ❌ token 泄露 |
| Actions 日志 | ✅ | ✅ | ❌ token 泄露 |
| Artifact 内容 | ❌ 401 | ❌ | ❌ 站点读不到 |
| Actions cache | ❌ | ❌ | ❌ 需 token |
| 私密 gist | ❌ | ❌ | ❌ 需 token |

### 加密能不能救？

理论上：站点生成一次性 nonce → 用户评论 issue 带上 nonce → workflow 用 nonce 派生密钥加密 token 写到公开位置 → 站点解密。

**不行**。因为 workflow 只能从公开渠道拿到 nonce（issue 评论、dispatch payload、workflow input 全都公开可见），
攻击者读到 nonce 就能同样解密。nonce 本身必须走一条「只有站点和 workflow 知道」的私有通道 —— 而 Actions 没有。

### 就算解决了回传，流程也更差

| 环节 | Cloudflare Worker | GitHub Actions |
|---|---|---|
| 触发 | 前端直接 POST | 用户要去 GitHub 网页评论 issue |
| 换 token | Worker 内 | Workflow 内 |
| 回传 | Worker 直接返回 | 需公开通道（不安全） |
| 用户操作 | **2 次点击** | 评论 + 等 workflow + 回来读 → **5+ 步** |
| 额外风险 | 无 | token 可能泄露 |

### 唯一还剩的 Actions 用法（不推荐）

用 `schedule` 每分钟轮询一个**用户自己保管的**待办队列 —— 但队列得存在哪？
还是那个问题：站点写不进去（写仓库需要 token），workflow 写出来的又是公开的。

**结论：GitHub Actions 不适合做 OAuth 中转。这不是配置问题，是它缺少「浏览器可读的私有回传通道」这一根本能力。**
