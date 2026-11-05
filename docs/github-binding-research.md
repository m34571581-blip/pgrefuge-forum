# GitHub 账号绑定 + 一键发布：技术调研与实现记录

调研时间：2026-11-03
目标：让用户在论坛站点绑定自己的 GitHub 账号，并把脱敏后的一键发布为 Discussion。

---

## 一、实测得到的硬约束

### 1. CORS —— 决定架构的关键事实

浏览器实测（Playwright，从任意 origin 真实发起）：

| 请求 | 结果 |
|---|---|
| `POST api.github.com/graphql` | ✅ 正常返回，**CORS 放行** |
| `GET api.github.com/users/octocat` | ✅ 200，CORS 放行 |
| `GET github.com/login/device`（no-cors） | opaque（正常，CORS 限制） |
| `POST github.com/login/device/code` | ❌ **TypeError: Failed to fetch = CORS 拦截** |

`api.github.com` 全站返回 `Access-Control-Allow-Origin: *`；
`github.com/login/*` 不返回 —— 这不是本机网络问题（同一浏览器里 api.github.com 全部正常），
是 GitHub 的策略。

**关键区分**：`api.github.com` 上**没有** OAuth 端点
（`/login/device/code`、`/authorizations`、`/applications/tokens` 全 404）。
OAuth 端点只在 `github.com` 下，而那里没有 CORS。

→ **换 token 必须有服务端中转；用 token 发帖可以浏览器直连。**

### 2. Device Flow 不需要 client_secret

GitHub 官方文档（Authorizing OAuth apps → Device flow → Step 2 参数表）：

> `client_secret` — "Required **unless the token was generated using the device flow**"
> `client_secret` "is not needed for the device flow."

实测佐证：换 token 时**不带** client_secret，GitHub 返回 `authorization_pending`
（正常等待授权）；带一个**错误的** client_secret 则直接失败（空响应）。

```text
POST https://github.com/login/device/code
  client_id=...&scope=public_repo
→ 200 {"device_code":"...","user_code":"0348-BDE5",
       "verification_uri":"https://github.com/login/device",
       "expires_in":899,"interval":5}
```

→ 中转服务只需 `client_id`（公开标识符），**不持有任何机密**。
这大幅降低了中转的安全门槛 —— 中转可以是无状态的纯转发器。

### 3. 发帖 API

```graphql
mutation {
  createDiscussion(input: {
    repositoryId: "<repo node id>",   # R_kgDOxxxx
    categoryId: "<category node id>", # DIC_kwDOxxxx
    title: "...",
    body: "..."
  }) { discussion { id url number } }
}
```

- **scope：公开仓库用 `public_repo`（私有仓库用 `repo`）**
- 非仓库协作者也可以创建 Discussion
- 仓库现状：`m34571581-blip/pgrefuge-forum`，public，`has_discussions: true`
  分类 `experiences`（id `DIC_kwDOA`）

### 4. 同步流水线

- cron 每 30 分钟跑一次（`17,47 * * * *` UTC）
- **同步时会把脱敏后的正文覆写回 GitHub 原帖** —— 这是产品的核心隐私承诺
- 含义：用户自己发原文的话，到下次同步前存在**明文窗口**（最多 30 分钟）

---

## 二、已实现的方案：PAT 绑定 + 浏览器直连发帖

### 为什么先做这个

Device Flow 需要中转服务，而现有基础设施都不具备（见下节）。
PAT 方案**零服务端**，今天就能上线，且功能完整。

### 架构

```
用户生成 fine-grained PAT（只勾 Discussions: Read and write，限定本仓库）
  → 粘贴到站点
  → 浏览器调 api.github.com/user        验证令牌
  → 浏览器调 api.github.com/graphql      取 repositoryId + categoryId
  → 浏览器调 api.github.com/graphql      createDiscussion
```

全程浏览器直连，无需任何服务端。

### 三条安全约束

1. **令牌只存内存**
   不写 localStorage / sessionStorage，刷新即失效。
   理由：本站会渲染用户提交的第三方内容（帖子正文），那是潜在的 XSS 注入面 ——
   注入成功的脚本能读走 localStorage 里的长期令牌。放内存里，
   风险窗口从「永久」缩到「当前会话」。

2. **发布的永远是脱敏后的内容**
   不是原文。同步管道虽然也会覆写，但要等最多 30 分钟 —— 中间是明文窗口。
   一键发布直接发脱敏版，窗口不存在。

3. **发布时做加严处理**
   引擎的 L3 层把「形态可疑但线索不足」的片段列进疑似清单但**不自动替换**
   （避免误伤）。但「发布」是不可逆的公开动作，所以发布这一步会把
   **所有疑似项一并脱敏**，并在结果里告知用户遮掉了什么 —— 不静默处理。

   实测：输入 `我在清华读研，导师姓李，我恨wangjunkai`
   → 发布内容 `我在某校读研，导师姓某，我恨Someone`
   → 提示「另已自动脱敏 2 处疑似内容：清华、wangjunkai」

4. **前端不自己写脱敏逻辑**
   发布内容由同一个引擎算出，含用户确认过的片段（复用 `confirmed` 回灌）。
   不复制一份规则 —— 否则浏览器端和同步管道会漂移。

---

## 三、方案二（Device Flow）的现实约束

### 现有基础设施能否承载中转？逐个实测

| 候选 | 结论 | 依据 |
|---|---|---|
| WorkBuddy 云服务（PostgreSQL） | ❌ | RPC 只支持预定义函数；数据库无外部 HTTP 扩展证据。`oauthRelayBaseUrl` 的 provider 是**平台级固定**的 —— 实测只支持 `google` / `wechat`，`github` 返回 400 |
| GitHub Pages | ❌ | 纯静态，无函数计算 |
| GitHub Actions | ❌ | 非常驻；触发 workflow 需仓库写权限，匿名用户没有 |
| 独立 serverless（Cloudflare Workers / Vercel） | ✅ 可行 | 但需新引入部署目标与域名 |

### 中转服务的最小形态

因为不需要 client_secret，中转极简：

```js
// POST {relay}/github/device/code   → 转发到 GitHub，返回 device_code 等
// POST {relay}/github/device/token  → 转发到 GitHub，返回 access_token 或 error
```

无状态、不存储、不持有机密。

---

## 四、文件清单

| 文件 | 作用 |
|---|---|
| `site/github-client.js` | GraphQL/REST 调用、令牌内存态、错误中文化 |
| `site/github-bind.js` | 取令牌的两种方式（PAT 粘贴 / Device Flow 中转），统一为 `bindWithToken()` |
| `site/index.html` | 绑定面板、发布按钮、发布时加严脱敏 |

---

## 五、待决策

Device Flow 的中转服务部署在哪 —— 需要引入新的部署目标，
属于「要不要多一个服务端」的决策，留给用户拍板。
PAT 方案不依赖它，已可独立上线。
