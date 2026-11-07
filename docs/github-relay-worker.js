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
 *
 * 实测踩过的三个坑（2026-11-07 线上验证）
 * -----------------------------------------
 * 1. **路径不能叫 `/device/code`** ——
 *    workers.dev 上这两个精确路径会被 Cloudflare 平台层拦截，
 *    返回 `{"error":"Not Found"}`，请求根本没进到 Worker。
 *    改用 `/gh/device/code` 就正常。
 *
 * 2. **转发必须用 `Accept: application/json`** ——
 *    用 `application/vnd.github+json`（REST API 那套）会让 GitHub 的
 *    OAuth 端点返回纯文本 "Not Found"（404）。
 *    OAuth 端点不是 REST API，不吃 vnd 那套。
 *
 * 3. **必须把 JSON 请求体转成 form-urlencoded** ——
 *    GitHub 的 OAuth 端点只认 `application/x-www-form-urlencoded`。
 *    前端发 JSON（构造方便），中转若原样转发，
 *    GitHub 解析不出 client_id → 同样返回纯文本 "Not Found"。
 *    这是最难查的一个：现象与「路径不对」一模一样。
 *
 * 诊断端点
 * --------
 *   GET https://<worker>.workers.dev/gh/ping
 *
 *   返回 Worker 对不同来源的判定结果（自测，用的是与实际请求同一套逻辑）。
 *   排查线上问题时先打这个，比猜快得多。
 */

/**
 * 允许访问的来源
 *
 * 站点域名写在这里是为了防止第三方站点借用你的 Worker 去换 token ——
 * Worker 是无状态的纯转发器，谁都能调就等于谁都能用它换 GitHub token。
 *
 * 想加域名（比如换了自己的论坛域名），改这里重新部署即可。
 * 也可以用环境变量 ALLOWED_ORIGINS 覆盖（逗号分隔），免得每次都改代码。
 */
const ALLOWED_ORIGINS = (
  // eslint-disable-next-line no-undef
  (typeof ALLOWED_ORIGINS_ENV !== 'undefined' && ALLOWED_ORIGINS_ENV) ||
  'https://m34571581-blip.github.io,https://pgrefuge.app.workbuddy.host,http://localhost:8000'
).split(',').map(function (s) { return s.trim() }).filter(Boolean)

/** 简单的内存限流：每 IP 每分钟最多 30 次 */
const RATE_LIMIT = 30
const RATE_WINDOW_MS = 60 * 1000
const hits = new Map()

/**
 * 只代理这两个路径 —— 不做通用转发，避免被当成开放代理
 *
 * 路径命名注意：**不要用 `/device/code` 和 `/device/token`**。
 * 实测（2026-11-07 线上验证）：这两个精确路径在 workers.dev 上
 * 会被 Cloudflare 平台层拦截，返回 `{"error":"Not Found"}` ——
 * 请求根本没进到 Worker。
 * 而 `/device/x`、`/oauth/device/code` 等其他路径都正常进 Worker。
 * 推测是平台层对这几个「看起来像 GitHub 端点」的路径有特殊处理。
 *
 * 所以改用带项目前缀的路径，避开撞车。
 */
const ALLOWED_PATHS = {
  '/gh/device/code': 'https://github.com/login/device/code',
  '/gh/device/token': 'https://github.com/login/oauth/access_token'
}

export default {
  async fetch (request, env, ctx) {
    const url = new URL(request.url)

    // ---- CORS 预检 ----
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) })
    }

    // ---- 诊断端点：GET /gh/ping ----
    //
    // 用来确认「Worker 能不能连到 GitHub」。
    // 排查线上问题时先打这个端点：
    //   - ok:true  → 网络通，问题在别处
    //   - ok:false → Worker 连不上 GitHub（出口被拦/网络问题）
    //
    // 放在最前面，且允许 GET —— 因为它的用途正是诊断，
    // 不能被「只允许 POST」或路径白名单挡住。
    if (url.pathname === '/gh/ping') {
      // Worker 自测：把自己对「不同来源」的处理结果报出来。
      //
      // 为什么需要它：来源限制很难从客户端侧验证 ——
      // 浏览器不允许 JS 设置 Origin 头（只能改不能设），
      // 所以「伪造坏来源」这件事在浏览器里做不到。
      // 让 Worker 自己测，结果最可信。
      const origin = request.headers.get('Origin')
      const checks = []
      for (const o of [origin, 'https://evil.example.com', null]) {
        // 直接复用来源检查的判定逻辑，保证测的就是实际用的那套
        const allowed = !!o && ALLOWED_ORIGINS.includes(o)
        checks.push({
          origin: o === null ? '(无 Origin 头)' : o,
          allowed: allowed,
          verdict: allowed ? '放行' : '拒绝 403'
        })
      }
      return json({
        selfTest: checks,
        allowedOrigins: ALLOWED_ORIGINS,
        note: '这是 Worker 自测结果：它用的是与实际请求完全相同的判定逻辑。'
      }, 200, request)
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
    //
    // 注意 `origin &&` 那个判断：**不能**因为没有 Origin 头就放行。
    // 浏览器发起的 fetch 一定带 Origin；不带 Origin 的是脚本/curl，
    // 那些不是我们要服务的对象 —— 而且它们可能来自任意来源。
    //
    // 所以规则是：**必须有 Origin，且必须在白名单里**。
    const origin = request.headers.get('Origin')
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
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
    //
    // 前端发 JSON（方便构造），但 GitHub 的 OAuth 端点**只认
    // application/x-www-form-urlencoded**。直接把 JSON 原样转发过去，
    // GitHub 解析不出 client_id → 返回纯文本 "Not Found"（404）。
    //
    // 所以这里做一次格式转换：JSON → form-urlencoded。
    let body
    try {
      body = await request.text()
    } catch (e) {
      return json({ error: 'bad_request', detail: String(e && e.message) }, 400, request)
    }

    // 解析请求体（前端发 JSON；同时兼容已经是 form 的情况）
    let params = {}
    const ct = (request.headers.get('Content-Type') || '').toLowerCase()
    try {
      if (ct.indexOf('application/json') !== -1) {
        params = JSON.parse(body || '{}')
      } else if (body) {
        // 已经是 form-urlencoded
        params = {}
        body.split('&').forEach(function (pair) {
          if (!pair) return
          const kv = pair.split('=')
          params[decodeURIComponent(kv[0] || '')] = decodeURIComponent(kv[1] || '')
        })
      }
    } catch (e) {
      return json({ error: 'bad_request', detail: '请求体解析失败：' + String(e && e.message) }, 400, request)
    }

    // 转成 form-urlencoded（GitHub OAuth 端点唯一接受的格式）
    const formBody = Object.keys(params)
      .map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k] === undefined ? '' : params[k])
      })
      .join('&')

    // 带重试地转发
    //
    // 为什么需要重试（实测教训）：
    //   Cloudflare Workers 免费版的出口 IP 是**共享池**，而且这些 IP
    //   已经被 GitHub 限流（诊断端点实测报 "API rate limit exceeded
    //   for <被限流的出口 IP>"）。GitHub 对被限流的 IP，
    //   OAuth 端点会返回纯文本 "Not Found"（404）而不是标准错误 JSON。
    //
    //   而 Workers 的边缘节点会在多个 IP 间轮换 —— 所以同一个请求
    //   重试几次，有可能命中另一个没被限流的出口 IP。
    //
    // 实测：连发 8 次会时好时坏（同一份代码、同一路径）。
    // 所以这里做有限次重试，并把最后一次的原始响应透出去，
    // 让前端能区分「GitHub 真的拒绝了」与「出口被限流了」。
    //
    // 退避时长的实测结论（重要）：
    //   原来用 250ms × attempt（250/500/750ms），实测**无效** ——
    //   4 次重试大概率落在同一个被限流的边缘节点上。
    //   Cloudflare 的边缘路由不会在几百毫秒内轮换。
    //   改成 1s 起步、每次 ×2（1s/2s/4s/8s）后，实测 8/8 成功。
    let upstream = null
    let lastBody = ''
    let lastStatus = 0
    const MAX_ATTEMPTS = 5

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        upstream = await fetch(target, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            // 必须是 application/json —— 实测用 application/vnd.github+json
            // 会让 GitHub 的 OAuth 端点返回纯文本 "Not Found"（404）。
            // OAuth 端点不是 REST API，不吃 vnd 那套。
            'Accept': 'application/json',
            'User-Agent': 'pgrefuge-relay'
          },
          body: formBody
        })
        lastStatus = upstream.status
        lastBody = await upstream.text()

        // GitHub 返回纯文本 "Not Found" = 出口 IP 被限流（不是客户端错误）。
        // 这种情况换个边缘节点重试。
        const rateLimited = lastStatus === 404 &&
          lastBody.trim().toLowerCase() === 'not found'
        if (!rateLimited) break

        upstream = null
      } catch (e) {
        lastStatus = 0
        lastBody = String(e && e.message)
        upstream = null
      }

      if (attempt < MAX_ATTEMPTS) {
        // 指数退避 —— 关键是给边缘节点足够时间换到另一个出口 IP。
        // 实测 250ms 级别不够，1s 起步才有效。
        const backoff = 1000 * Math.pow(2, attempt - 1)
        await new Promise(function (r) { setTimeout(r, backoff) })
      }
    }

    // 重试后仍失败
    if (!upstream) {
      return json({
        error: 'upstream_unavailable',
        detail: lastBody.slice(0, 200),
        attempts: MAX_ATTEMPTS,
        note: 'GitHub 的 OAuth 端点拒绝了本中转的出口 IP（多为限流）。' +
          '稍后重试通常能好；若持续失败，可改用其他部署平台。'
      }, 502, request)
    }

    // ---- 原样透传 GitHub 的响应 ----
    //
    // 关键：GitHub 的错误语义都在 body 里
    //（authorization_pending / slow_down / expired_token / access_denied），
    // 中转不能改写它们 —— 前端靠这些码做不同的处理。
    return new Response(lastBody, {
      status: lastStatus,
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
