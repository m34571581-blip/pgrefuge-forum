/**
 * GitHub 绑定层（github-bind.js）
 *
 * 职责：拿到访问令牌，并把它交给 github-client.js 使用。
 *
 * 两种取令牌的方式
 * ----------------
 * A. PAT 粘贴（当前可用，零服务端）
 *    用户在 GitHub 设置页生成一个 fine-grained PAT，
 *    只勾 Discussions: Read and write 且限定 PGrefuge 这一个仓库，
 *    粘贴到站点输入框。
 *
 * B. Device Flow 中转（待服务端就绪）
 *    点按钮 → 显示 8 位码 → 去 github.com/login/device 输入 → 自动完成。
 *    需要一个能持有 GitHub client_secret 的服务端做 token 交换
 *    （实测 GitHub 的 OAuth 端点无 CORS 头，浏览器无法直连）。
 *
 * 设计上把两者抽象成同一个接口 `acquireToken()`，
 * 这样服务端就绪时只需换掉实现，UI 与发帖逻辑完全不用动。
 *
 * 关于 client_id
 * -------------
 * client_id 是**公开标识符**，不是密钥，可以放在前端。
 * client_secret 才是密钥 —— 它绝不能进前端代码。
 * 所以 Device Flow 的中转服务只需要 client_id 之外的东西：
 * 实际上换 token 时 OAuth App 的 token 端点需要 client_secret，
 * 因此中转服务必须持有 secret。这正是 B 方案需要服务端的原因。
 */

const GH = typeof window !== 'undefined' && window.PGGitHub
  ? window.PGGitHub
  : (typeof require === 'function' ? require('./github-client') : null)

/**
 * 中转服务地址
 *
 * 为空表示未配置 Device Flow —— 界面会自动隐藏该入口，
 * 只展示 PAT 粘贴方式。
 * 配置后填入形如 https://xxx.app.workbuddy.host 的地址。
 */
const RELAY_BASE = (typeof window !== 'undefined' && window.PG_CONFIG && window.PG_CONFIG.oauthRelayBaseUrl) || ''

/** 绑定结果回调 */
let onBound = null
let onUnbound = null
let onProgress = null

function setHandlers (handlers) {
  onBound = handlers.onBound || null
  onUnbound = handlers.onUnbound || null
  onProgress = handlers.onProgress || null
}

function notifyProgress (stage, detail) {
  if (onProgress) onProgress(stage, detail)
}

/**
 * 方式 A：粘贴 PAT
 *
 * @param {string} token
 * @param {object} cfg { repo, category }
 * @returns {Promise<object>} 绑定后的状态
 */
async function bindWithToken (token, cfg) {
  notifyProgress('verify', '正在验证令牌…')
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
 * 方式 B：Device Flow
 *
 * 需要中转服务端提供两个接口：
 *   POST {relay}/github/device/code   → { device_code, user_code, verification_uri, interval, expires_in }
 *   POST {relay}/github/device/token  → { access_token } 或 { error, interval }
 *
 * 中转服务持有 client_secret，浏览器全程拿不到 secret。
 *
 * @param {object} cfg
 * @returns {Promise<object>} 绑定后的状态
 */
async function bindWithDeviceFlow (cfg) {
  if (!RELAY_BASE) {
    throw new Error('Device Flow 尚未配置中转服务，请改用粘贴令牌的方式')
  }

  notifyProgress('device', '正在申请设备码…')
  const devRes = await fetch(RELAY_BASE + '/github/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'public_repo' })
  })
  if (!devRes.ok) {
    const t = await devRes.text()
    throw new Error('申请设备码失败（HTTP ' + devRes.status + '）：' + t.slice(0, 200))
  }
  const dev = await devRes.json()

  notifyProgress('waiting', dev.user_code, dev.verification_uri)

  const token = await pollForDeviceToken(dev)

  notifyProgress('verify', '正在验证令牌…')
  return bindWithToken(token, cfg)
}

/**
 * 轮询设备码授权结果
 *
 * 必须遵守 RFC 8628 的 slow_down 规则：
 * 收到 slow_down 就把间隔加 5 秒 —— 忽略它会导致永远拿不到令牌。
 */
async function pollForDeviceToken (dev) {
  let interval = (dev.interval || 5) * 1000
  const deadline = Date.now() + (dev.expires_in || 900) * 1000

  while (Date.now() < deadline) {
    await sleep(interval)

    const res = await fetch(RELAY_BASE + '/github/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: dev.device_code })
    })
    const payload = await res.json().catch(function () { return {} })

    if (payload.access_token) return payload.access_token

    if (payload.error === 'slow_down') {
      interval += 5000
      continue
    }
    if (payload.error === 'authorization_pending') continue
    if (payload.error === 'expired_token') {
      throw new Error('授权码已过期，请重新发起绑定')
    }
    if (payload.error === 'access_denied') {
      throw new Error('你取消了授权')
    }
    if (payload.error) {
      throw new Error('授权失败：' + payload.error)
    }
  }
  throw new Error('授权超时，请重新发起绑定')
}

function sleep (ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms) })
}

/**
 * 解绑：清除内存中的令牌
 */
function unbind () {
  GH.reset()
  if (onUnbound) onUnbound()
}

function isDeviceFlowAvailable () {
  return !!RELAY_BASE
}

function getRelayBase () {
  return RELAY_BASE
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    setHandlers,
    bindWithToken,
    bindWithDeviceFlow,
    unbind,
    isDeviceFlowAvailable,
    getRelayBase
  }
}

// 浏览器环境挂到全局 —— 站点用 <script src> 引入，没有 require。
if (typeof window !== 'undefined') {
  window.PGGitHubBind = {
    setHandlers: setHandlers,
    bindWithToken: bindWithToken,
    bindWithDeviceFlow: bindWithDeviceFlow,
    unbind: unbind,
    isDeviceFlowAvailable: isDeviceFlowAvailable,
    getRelayBase: getRelayBase
  }
}
