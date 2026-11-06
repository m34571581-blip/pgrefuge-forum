/**
 * PGrefuge GitHub OAuth 中转（Cloudflare Worker）
 *
 * 为什么需要它
 * ------------
 * 实测（2026-11-03）：
 *   api.github.com/graphql              → Access-Control-Allow-Origin: *  ✅
 *   github.com/login/device/code        → 无 CORS 头，浏览器直连被拦截      ❌
 *   github.com/login/oauth/access_token → 无 CORS 头，浏览器直连被拦截      ❌
 *
 *   所以「用 token 发帖」可以浏览器直连，「换 token」必须服务端转发。
 *
 * 为什么它不持有机密
 * ------------------
 * GitHub 官方文档：
 *   "client_secret — Required unless the token was generated using the device flow"
 *   "client_secret is not needed for the device flow."
 *
 * 实测佐证：换 token 时不带 client_secret → 返回 authorization_pending（正常流程）；
 *           带一个错误的 client_secret   → 直接失败。
 *
 *   Device Flow 只需要 client_id —— 那是**公开标识符**，不是密钥。
 *   所以这个 Worker 不存任何机密、不落任何状态，只做转发。
 *
 * 部署
 * ----
 *   1. 注册一个 GitHub OAuth App
 *      GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
 *      - Application name:  PGrefuge Forum
 *      - Homepage URL:      https://m34571581-blip.github.io/pgrefuge-forum/
 *      - Authorization callback URL: 同上（Device Flow 不强制用，但填上更规范）
 *      - 勾选 "Enable Device Flow"
 *      → 拿到 Client ID（公开，填进站点的 config.js）
 *
 *   2. 部署这个 Worker
 *      最快：打开 Cloudflare Dashboard → Workers & Pages → Create → 粘贴本文件 → Deploy
 *      或用命令行：
 *        npx wrangler deploy github-relay-worker.js --name pgrefuge-relay
 *
 *   3. 把 Worker 地址填进站点配置 site/config.js：
 *        oauthRelayBaseUrl: 'https://pgrefuge-relay.<你的子域>.workers.dev',
 *        githubOAuthClientId: 'Iv1.xxxxxxxxxxxx'
 *
 * 安全设计
 * --------
 * - **无状态**：不存 device_code、不存 token，转发完就忘
 * - **不持有机密**：只需要公开的 client_id
 * - **白名单**：只代理两个固定路径，且只接受 POST
 * - **来源限制**：用 CORS 头限定允许的站点（改成你自己的域名）
 * - **限流**：简单的 IP 计数，防止被当成开放代理滥用
 *
 * 注意：Client ID 不写死在 Worker 里 —— 由前端传进来。
 * 因为 client_id 是公开值，这样 Worker 与 App 解耦，
 * 换 App 不用重新部署 Worker。
 */

/** 允许访问的来源 —— 改成你自己的站点域名 */
const ALLOWED_ORIGINS = [
  'https://m34571581-blip.github.io',
  'https://pgrefuge.app.workbuddy.host',
  'http://localhost:8000'
]

/** 简单的内存限流：每 IP 每分钟最多 30 次 */
const RATE_LIMIT = 30
const RATE_WINDOW_MS = 60 * 1000
const hits = new Map()

/**
 * 只代理这两个路径 —— 不做通用转发，避免被当成开放代理
 */
const ALLOWED_PATHS = {
  '/device/code': 'https://github.com/login/device/code',
  '/device/token': 'https://github.com/login/oauth/access_token'
}

export default {
  async fetch (request, env, ctx) {
    const url = new URL(request.url)

    // ---- CORS 预检 ----
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) })
    }

    // ---- 只允许 POST ----
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405, request)
    }

    // ---- 路径白名单 ----
    const target = ALLOWED_PATHS[url.pathname]
    if (!target) {
      return json({ error: 'not_found' }, 404, request)
    }

    // ---- 来源限制 ----
    const origin = request.headers.get('Origin')
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'origin_not_allowed' }, 403, request)
    }

    // ---- 限流 ----
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
    const now = Date.now()
    const rec = hits.get(ip) || { count: 0, start: now }
    if (now - rec.start > RATE_WINDOW_MS) {
      rec.count = 0
      rec.start = now
    }
    rec.count++
    hits.set(ip, rec)
    if (rec.count > RATE_LIMIT) {
      return json({ error: 'rate_limited' }, 429, request)
    }

    // ---- 转发 ----
    let body
    try {
      body = await request.text()
    } catch (e) {
      return json({ error: 'bad_request' }, 400, request)
    }

    let upstream
    try {
      upstream = await fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body
      })
    } catch (e) {
      return json({ error: 'upstream_failed' }, 502, request)
    }

    // ---- 原样透传 GitHub 的响应 ----
    //
    // 关键：GitHub 的错误语义都在 body 里
    //（authorization_pending / slow_down / expired_token / access_denied），
    // 中转不能改写它们 —— 前端靠这些码做不同的处理。
    const text = await upstream.text()
    return new Response(text, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': origin || ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        'Cache-Control': 'no-store'
      }
    })
  }
}

function corsHeaders (request) {
  const origin = request.headers.get('Origin')
  return {
    'Access-Control-Allow-Origin': origin || ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  }
}

function json (obj, status, request) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(request)
    }
  })
}
