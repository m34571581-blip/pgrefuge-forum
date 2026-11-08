# 一键绑定 GitHub 账号 —— 部署指南

现状是「粘贴令牌」，流程断点多（去设置页 → 找令牌生成器 → 填表 → 勾权限 → 生成 → 复制 → 切回粘贴），约 10 步。

这份指南把它变成 **2 次点击**。

---

## 一、整体流程

```
用户点「一键绑定」
  → 站点向中转申请设备码
  → 中转向 GitHub 申请 → 返回 8 位验证码（如 ABCD-1234）
  → 站点显示验证码 + 授权链接（链接已带 ?user_code=，GitHub 自动填码）
  → 用户点链接 → 在 GitHub 点 Authorize（1 次点击）
  → 站点持续轮询 → 拿到令牌 → 绑定完成
```

用户操作：**点「一键绑定」+ 点「Authorize」**，其余全自动。

---

## 二、需要你做的三件事

### 第 1 步：注册 GitHub OAuth App

GitHub → 右上角头像 → **Settings** → 最下方 **Developer settings** →
**OAuth Apps** → **New OAuth App**

| 字段 | 填什么 |
|---|---|
| Application name | `PGrefuge Forum` |
| Homepage URL | `https://m34571581-blip.github.io/pgrefuge-forum/` |
| Authorization callback URL | 同上 |

**然后勾选「Enable Device Flow」**（页面底部），并保存。

保存后拿到 **Client ID**（形如 `Ov23liabc123def456`）。
这是**公开标识符**，不是密钥 —— 放在前端是安全的。

> 不需要 Client Secret —— Device Flow 的换 token 不需要它
> （GitHub 官方文档：*"client_secret is not needed for the device flow"*，已实测验证）。

### 第 2 步：部署中转 Worker

完整源码在 **`docs/github-relay-worker.js`**（约 130 行，零依赖）。

#### 在哪里运行

**在你自己的电脑上**，用 **Git Bash**（Windows 上的 Git 终端）。
不是浏览器、不是 GitHub 网页 —— 这是一条命令行命令。

打开 Git Bash 后，先 `cd` 到工作区根目录：

```bash
cd /g/clus_4_t/build_my_skill        # Git Bash 的路径写法
bash pgrefuge-forum/docs/deploy-relay.sh
```

或者不进目录、直接用绝对路径（Windows 风格也行）：

```bash
bash "G:/clus_4_t/build_my_skill/pgrefuge-forum/docs/deploy-relay.sh"
```

> **前置条件**：Node.js 18+（提供 `npx`）。本机已确认可用：
> Node v22.22.2 / npx 10.9.7 / bash 5.3.15。
> wrangler 不需要预装，脚本会用 `npx` 自动拉取。

#### 脚本会做什么

1. 检查 Node / npx 是否可用
2. 检查 Cloudflare 登录状态（没登录会自动打开浏览器让你授权，一次性）
3. 部署 Worker 并打印出要填进 `config.js` 的两行

#### 第 3 步可能会遇到的：注册 workers.dev 子域名

这是**首次部署必需的一次性操作**（账号级，注册后所有 Worker 都能用）。
脚本会检测到并给你链接，形如：

```
⚠ 首次部署需要先注册 workers.dev 子域名（一次性操作）。

  请打开这个链接完成注册：
    https://dash.cloudflare.com/<你的账号ID>/workers/onboarding

  点「Get started」→ 选 Free 计划 → 输入一个子域名前缀（比如 pgrefuge）
  注册完再重跑本脚本。
```

进去之后：点 **Get started** → 选 **Free** 计划 → 输入一个子域名前缀
（比如 `pgrefuge`，这个前缀会成为你的 Worker 地址前缀）
→ 确认 → 回到终端重跑脚本。

> 为什么必须先注册：wrangler 在没注册时会弹交互式提问
> "Would you like to register a workers.dev subdomain now?"，
> 而脚本运行时是非交互环境，它会拿默认值（否）→ 部署直接失败。
> 脚本已经提前检测并引导，不会让你卡在这里。

#### 已部署的实例

```
https://pgrefuge-relay.m34571581.workers.dev
```

站点 `site/config.js` 里已经填好这个地址。

#### 如果浏览器没自动打开

手动打开脚本给出的链接完成登录，或直接用 Dashboard 部署：

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages
2. Create → Worker → 起名 `pgrefuge-relay` → Deploy
3. 点进去 → Edit code → 全选删除，粘贴 `docs/github-relay-worker.js` 的内容 → Deploy

#### 或者用命令行（不用脚本）

```bash
npx wrangler deploy pgrefuge-forum/docs/github-relay-worker.js --name pgrefuge-relay
```

拿到地址，形如 `https://pgrefuge-relay.<你的子域>.workers.dev`。

> Worker 是**免费额度**内的小服务 —— 每次绑定 2~3 个请求，够用很久。
> 它无状态、不存储任何东西、不持有任何机密。

### 第 3 步：填站点配置

编辑 `site/config.js`：

```js
window.PG_CONFIG = {
  repo: 'm34571581-blip/pgrefuge-forum',
  category: 'experiences',
  categorySlug: 'experiences',

  // ↓ 填这两行
  oauthRelayBaseUrl: 'https://pgrefuge-relay.<你的子域>.workers.dev',
  githubOAuthClientId: 'Ov23liabc123def456'
};
```

提交推送，Actions 会自动重新部署站点。

---

## 三、验证是否成功

部署后打开站点，点「一键绑定」，应该看到：
- 一个 8 位验证码（如 `ABCD-1234`）
- 一个「打开 GitHub 授权页 →」按钮

点按钮 → GitHub 页面自动填好验证码 → 点 **Authorize** → 回到站点自动完成绑定。

若提示「连不上快速绑定服务（地址）」→ 检查 Worker 地址是否填对、Worker 是否已部署。

---

## 四、兜底：粘贴令牌

中转服务没配好、Worker 超额、或用户不想授权时，站点**自动降级**为粘贴令牌方式：

- 点「一键绑定」失败后，页面自动切出令牌输入框
- 用户在 GitHub 生成 fine-grained PAT 并粘贴
- 生成方式：Settings → Developer settings → Personal access tokens →
  **Fine-grained tokens** → Generate new token
  - **Repository access** → Only select repositories → 只选 PGrefuge 仓库
  - **Repository permissions → Discussions** → Read and write
  - 其余权限一项都不勾

这样这个令牌只能给论坛发讨论，读不到用户的其他仓库。

---

## 五、安全设计

| 项 | 做法 | 为什么 |
|---|---|---|
| 令牌存储 | **只存内存**，刷新即失效 | 站点会渲染用户提交的帖子正文，那是潜在的 XSS 面。放内存里风险窗口从「永久」缩到「当前会话」 |
| 中转服务 | 无状态、不存储、不持有机密 | 只转发两个 POST，转发完就忘 |
| 中转路径 | 白名单（只有 `/device/code` 与 `/device/token`） | 防止被当成开放代理滥用 |
| 中转来源 | CORS 限定站点域名 | 防止第三方站点借用你的 Worker |
| 中转限流 | 每 IP 每分钟 30 次 | 防止刷爆 Worker 额度 |
| 发布内容 | **脱敏后才提交** | GitHub 上从一开始就只有脱敏版，没有明文窗口 |
| Web OAuth | **不用**（它必须持 client_secret） | Device Flow 免 secret，中转零机密 |

---

## 六、为什么必须有中转

实测（2026-11-03，curl + Playwright 真实浏览器双向验证）：

| 端点 | CORS 头 | 浏览器可直连 |
|---|---|---|
| `api.github.com/graphql` | `ACAO: *` | ✅ |
| `api.github.com` REST | `ACAO: *` | ✅ |
| `github.com/login/device/code` | **无** | ❌ `TypeError: Failed to fetch` |
| `github.com/login/oauth/access_token` | **无** | ❌ |

且 `api.github.com` 上没有 OAuth 端点（`/login/device/code`、`/authorizations`、`/applications/tokens` 全 404）。

所以：**用 token 发帖能浏览器直连，换 token 必须服务端转发**。
这是 GitHub 的服务端策略，前端无法绕过（`no-cors` 读不到响应体，JSONP 不支持）。

---

## 七、如果不想部署 Worker

那就保持现状的粘贴令牌方式 —— 功能完全一样，只是多几步操作。
代码已做好降级：把 `config.js` 里两项留空即可，站点只显示粘贴令牌入口。
