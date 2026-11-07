/**
 * GitHub 绑定层（github-bind.js）
 *
 * 职责：拿到访问令牌，并把它交给 github-client.js 使用。
 *
 * 两种取令牌的方式
 * ----------------
 * A. Device Flow（顺畅，推荐）
 *    点按钮 → 显示 8 位码 + 授权链接 → 用户在 GitHub 点 Authorize
 *    → 页面自动跳回 → 绑定完成。用户只点 2 次。
 *
 * B. PAT 粘贴（兜底，零服务端）
 *    用户在 GitHub 设置页生成 fine-grained PAT，粘贴到站点。
 *    中转没配 / 挂了 / GitHub 改策略时用这个。
 *
 * 两种方式抽象成同一个入口 `bind()`，UI 与发帖逻辑不受影响。
 *
 * 为什么必须有中转（实测结论）
 * --------------------------
 *   api.github.com/graphql            → ACAO: *          ✅ 浏览器可直连
 *   api.github.com REST               → ACAO: *          ✅ 浏览器可直连
 *   github.com/login/device/code      → 无 ACAO 头        ❌ 浏览器被拦
 *   github.com/login/oauth/access_token → 无 ACAO 头      ❌ 浏览器被拦
 *   api.github.com 上没有 OAuth 端点（/login/device/code 等全 404）
 *
 *   所以：**用 token 发帖可以浏览器直连，换 token 必须服务端转发**。
 *   这是 GitHub 的服务端策略，前端无法绕过。
 *
 * 关于 client_secret（实测）
 * -------------------------
 *   Web OAuth Flow 换 token：不带 secret → incorrect_client_credentials  ← 必须带
 *   Device Flow  换 token：不带 secret → authorization_pending           ← 正常流程
 *
 *   官方文档原文：
 *     "client_secret — Required unless the token was generated using the device flow"
 *     "client_secret is not needed for the device flow."
 *
 *   所以选 Device Flow —— **中转服务不持有机密**，只转发两个 POST。
 *
 * 中转服务的形态（docs/github-relay-worker.js 有完整可部署源码）
 * -----------------------------------------------------------
 *   POST {relay}/device/code  → 转发到 github.com/login/device/code
 *   POST {relay}/device/token → 转发到 github.com/login/oauth/access_token
 *
 *   无状态、不存储、不持有机密。
 */

const GH = typeof window !== 'undefined' && window.PGGitHub
  ? window.PGGitHub
  : (typeof require === 'function' ? require('./github-client') : null)

/**
 * 中转服务地址
 *
 * 为空 → 未配置 Device Flow → 只显示 PAT 粘贴方式。
 * 配置后形如 https://pgrefuge-relay.workers.dev
 *
 * 刻意做成**函数**而不是模块加载时读常量：
 *   config.js 是 <script src> 引入的，若本模块比它先执行，
 *   加载时读到的会是 undefined。运行时读则永远拿到最新值。
 */
function getRelayBase () {
  const cfg = (typeof window !== 'undefined' && window.PG_CONFIG) || {}
  return cfg.oauthRelayBaseUrl || ''
}

/**
 * GitHub OAuth App 的 client_id
 *
 * 公开标识符，不是密钥，可以放在前端。
 * 需要用户在 GitHub → Settings → Developer settings → OAuth Apps 注册后拿到。
 */
function getClientId () {
  const cfg = (typeof window !== 'undefined' && window.PG_CONFIG) || {}
  return cfg.githubOAuthClientId || ''
}

/** 绑定结果回调 */
let onBound = null
let onUnbound = null
let onProgress = null

function setHandlers (handlers) {
  onBound = handlers.onBound || null
  onUnbound = handlers.onUnbound || null
  onProgress = handlers.onProgress || null
}

function notifyProgress (stage, detail, extra) {
  if (onProgress) onProgress(stage, detail, extra || null)
}

/**
 * Device Flow 是否可用
 *
 * 三个条件缺一不可：中转地址、client_id 都在。
 */
function isDeviceFlowAvailable () {
  return !!(getRelayBase() && getClientId())
}

/**
 * 统一入口：绑定 GitHub 账号
 *
 * 优先 Device Flow（顺畅）；中转不可用时回落到 PAT 粘贴。
 *
 * @param {object} cfg { owner, repo, category }
 * @param {object} [opts] { forceToken: true } 强制走 PAT 方式
 * @returns {Promise<object>} 绑定信息
 */
async function bind (cfg, opts) {
  const o = opts || {}
  if (!o.forceToken && isDeviceFlowAvailable()) {
    try {
      return await bindWithDeviceFlow(cfg)
    } catch (e) {
      // 中转挂了不该让用户卡住 —— 落到 PAT 方式
      notifyProgress('fallback', '快速绑定不可用：' + (e && e.message ? e.message : '未知原因'))
      throw e
    }
  }
  // 没配中转 → 提示 UI 走 PAT 路径
  const e = new Error('未配置快速绑定服务，请改用粘贴令牌的方式')
  e.code = 'no_relay'
  throw e
}

/**
 * 方式 A：Device Flow
 *
 * 流程：
 *   1. POST {relay}/device/code  → 拿 user_code 与 verification_uri
 *   2. 弹层显示 8 位码，用户点链接去 GitHub 授权
 *   3. 轮询 POST {relay}/device/token 直到拿到 access_token
 *
 * 轮询必须遵守 RFC 8628：
 *   - authorization_pending → 继续等
 *   - slow_down             → 间隔 +5 秒（**必须遵守**，否则永远拿不到）
 *   - expired_token         → 过期，重新发起
 *   - access_denied         → 用户取消
 */
async function bindWithDeviceFlow (cfg) {
  const relay = getRelayBase()
  const clientId = getClientId()
  if (!relay) throw new Error('未配置中转服务')
  if (!clientId) throw new Error('未配置 GitHub OAuth App 的 client_id')

  notifyProgress('device', '正在申请设备码…')
  const dev = await postRelay('/gh/device/code', {
    client_id: clientId,
    scope: 'public_repo'
  })

  if (!dev || !dev.device_code || !dev.user_code) {
    throw new Error('中转服务返回了无效的设备码：' + JSON.stringify(dev).slice(0, 150))
  }

  // 把验证码交给 UI 显示，用户点链接去 GitHub 授权
  notifyProgress('waiting', dev.user_code, {
    userCode: dev.user_code,
    verificationUri: dev.verification_uri || 'https://github.com/login/device',
    expiresIn: dev.expires_in || 900,
    interval: dev.interval || 5
  })

  const token = await pollForDeviceToken(dev)
  notifyProgress('verify', '正在验证令牌…')
  return finishBind(token, cfg)
}

/**
 * 轮询设备码授权结果
 */
async function pollForDeviceToken (dev) {
  let interval = (dev.interval || 5) * 1000
  const deadline = Date.now() + ((dev.expires_in || 900) * 1000)

  while (Date.now() < deadline) {
    await sleep(interval)

    let payload
    try {
      payload = await postRelay('/gh/device/token', { device_code: dev.device_code })
    } catch (e) {
      // 网络抖动不该直接失败 —— 继续轮询
      continue
    }

    if (payload && payload.access_token) return payload.access_token

    const err = payload && payload.error
    if (err === 'slow_down') {
      // RFC 8628：必须把间隔加 5 秒，否则 GitHub 会持续限流
      interval += 5000
      continue
    }
    if (err === 'authorization_pending') continue
    if (err === 'expired_token') throw new Error('授权码已过期，请重新发起绑定')
    if (err === 'access_denied') throw new Error('你取消了授权')
    if (err) throw new Error('授权失败：' + err)
  }
  throw new Error('授权超时，请重新发起绑定')
}

/**
 * 方式 B：PAT 粘贴
 *
 * 令牌由 UI 直接传入 —— 不用「等待器」那套间接机制。
 *
 * 为什么要去掉等待器：
 *   等待器（Promise + resolver）要求 UI 侧自己接 .then/.catch，
 *   一旦 UI 忘了接，错误就静默丢失，用户看到的是「点了没反应」。
 *   直接传 token + 返回 Promise，错误自然沿 Promise 链冒泡，
 *   UI 只要 .catch 就能拿到 —— 没有可以漏的地方。
 *
 * @param {string} token 用户粘贴的令牌
 * @param {object} cfg { owner, repo, category }
 * @returns {Promise<object>} 绑定信息
 */
async function bindWithToken (token, cfg) {
  if (!token || typeof token !== 'string' || !token.trim()) {
    throw new Error('请先粘贴 GitHub 令牌')
  }
  notifyProgress('verify', '正在验证令牌…')
  return finishBind(token.trim(), cfg)
}

/**
 * 令牌拿到后的收尾：验证 + 读仓库元信息 + 查权限
 */
async function finishBind (token, cfg) {
  const user = await GH.verifyToken(token)

  notifyProgress('meta', '正在读取仓库与分类…')
  const meta = await GH.fetchRepoMeta(token, cfg.owner, cfg.repo, cfg.category)

  notifyProgress('perm', '正在检查发帖权限…')
  const perm = await GH.checkRepoPermission(token, cfg.owner, cfg.repo)

  const result = {
    login: user.login,
    avatarUrl: user.avatarUrl,
    repositoryId: meta.repositoryId,
    categoryId: meta.categoryId,
    categoryName: meta.categoryName,
    categories: meta.categories,
    permission: perm.permission,
    canPost: perm.canPost
  }

  if (onBound) onBound(result)
  return result
}

/**
 * 调用中转服务
 */
async function postRelay (path, body) {
  const res = await fetch(getRelayBase() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch (e) {
    throw new Error('中转服务返回了非 JSON 内容（HTTP ' + res.status + '）：' + text.slice(0, 120))
  }
  if (!res.ok && !payload.error) {
    throw new Error('中转服务出错（HTTP ' + res.status + '）')
  }
  return payload
}

function sleep (ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms) })
}

/**
 * 解绑：清除内存中的令牌
 *
 * @param {string} [reason] 解绑原因，传给 onUnbound 回调
 *   'expired' —— 令牌过期被动解绑（提示语与主动解绑不同）
 */
function unbind (reason) {
  GH.reset()
  if (onUnbound) onUnbound(reason || 'manual')
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    setHandlers,
    bind,
    bindWithDeviceFlow,
    bindWithToken,
    unbind,
    isDeviceFlowAvailable,
    getRelayBase,
    getClientId
  }
}

// 浏览器环境挂到全局 —— 站点用 <script src> 引入，没有 require。
if (typeof window !== 'undefined') {
  window.PGGitHubBind = {
    setHandlers: setHandlers,
    bind: bind,
    bindWithDeviceFlow: bindWithDeviceFlow,
    bindWithToken: bindWithToken,
    unbind: unbind,
    isDeviceFlowAvailable: isDeviceFlowAvailable,
    getRelayBase: getRelayBase,
    getClientId: getClientId
  }
}
