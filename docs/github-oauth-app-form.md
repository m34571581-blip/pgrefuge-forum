# 注册 GitHub OAuth App —— 逐项填写说明

截图里的表单有几处容易填错的地方，这里逐项说明**填什么**和**为什么**。

---

## 逐项对照表

| 表单项 | 填什么 | 说明 |
|---|---|---|
| **Application name** | `PGrefuge Forum` | 会显示在用户的 GitHub 授权页上，让人知道授权给谁。建议带产品名，别用个人项目名 |
| **Homepage URL** | `https://m34571581-blip.github.io/pgrefuge-forum/` | 站点首页。GitHub 会把它显示在授权页的 OAuth App 名称下方 |
| **Application description** | `PGrefuge 研究生庇护所 —— 用于一键把脱敏后的经历发布为讨论主题` | 用户能看到，能说明用途与权限范围。可留空 |
| **Redirect URI** | `https://m34571581-blip.github.io/pgrefuge-forum/` | **Device Flow 实际不用它**，但表单要求至少填一个。填站点地址即可 |
| **Allow wildcard matching** | **不勾** | 勾了等于允许任意子域名回调 —— 我们不需要，勾上只是扩大攻击面 |
| **Enable Device Flow** | ✅ **必须勾** | **这是整个方案的关键**。不勾就没有 `/login/device/code` 端点，一键绑定无法工作 |
| **Expire user access tokens** | ✅ 保持勾选（默认） | token 8 小时过期 → 泄露窗口小。代码已处理过期后的重新绑定 |

---

## 两个必须解释的选项

### 1. Enable Device Flow —— 必须勾

我们的一键绑定走 GitHub 的 Device Flow（设备码流程）：

```
点「一键绑定」→ 拿到 8 位验证码 → 去 GitHub 授权 → 自动回到站点
```

这个流程**不需要 client_secret**，所以中转服务是零机密的纯转发器。
不勾这一项，`/login/device/code` 端点不可用，整个一键绑定就废了。

### 2. Expire user access tokens —— 建议保持勾选

勾上之后 access token 8 小时过期，同时会返回 refresh_token（6 个月有效）。

我们**不使用 refresh_token** —— 令牌只存在浏览器内存里，刷新页面就没了。
所以实际影响是：用户标签页开着超过 8 小时后再发帖，会收到「令牌已过期」。

**这个情况已经处理好了**：发布失败会自动回到未绑定状态，
「一键绑定」按钮重新出现，点一下重新授权即可（2 次点击）。
不会卡在"提示错误但什么都点不了"的死局。

---

## 不需要填的东西

表单下方还有几项，**都不用动**：

- **Client secret**：不用管它。Device Flow 换 token 不需要 secret。
  页面会显示一个 client secret，但那是给 Web OAuth Flow 用的，我们不用。
  **不要把它填进任何前端代码或配置文件。**
- **Scopes / 权限**：这个表单里没有。权限在授权时由 `scope=public_repo` 决定，
  我们的 Worker 会自动带上。

---

## 填完之后

1. 点 **Register application**
2. 页面会显示 **Client ID**（形如 `Ov23lia1b2c3d4e5f6`）—— 这是公开标识符，可以放前端
3. **Client secret 不用复制**（用不上）

然后把 Client ID 给我，我帮你写进 `site/config.js`。

---

## 还差一步：部署中转 Worker

GitHub 的 OAuth 端点（`github.com/login/*`）**不返回 CORS 头**，
浏览器无法直接调用 —— 实测报 `TypeError: Failed to fetch`。
所以换 token 这一步必须由一个中转服务代为转发。

好消息是中转**零机密**（只需要公开的 Client ID），部署很简单：

```bash
bash pgrefuge-forum/docs/deploy-relay.sh
```

首次会引导登录 Cloudflare（浏览器跳转，粘贴一次授权码），
然后自动部署并打印出要填进 `config.js` 的两行。

---

## 最终要填进 site/config.js 的内容

```js
oauthRelayBaseUrl: 'https://pgrefuge-relay.<你的子域>.workers.dev',
githubOAuthClientId: 'Ov23lia1b2c3d4e5f6'
```

填完提交推送，Actions 会自动重新部署站点，
「一键绑定」按钮就会从「粘贴令牌」切换成「点两下完成」。
