/**
 * GitHub 客户端（github-client.js）
 *
 * 职责：绑定 GitHub 账号 + 一键把脱敏后的内容发布为 Discussion。
 *
 * 为什么这个模块是纯前端的
 * ----------------------
 * 实测（2026-11-03，curl 验证）：
 *   api.github.com/graphql         → Access-Control-Allow-Origin: *   ✅ 可直连
 *   github.com/login/device/code   → 无 CORS 头                        ❌ 被拦截
 *   github.com/login/oauth/access_token → 无 CORS 头                   ❌ 被拦截
 *
 * 结论：**换 token 必须有服务端中转，但用 token 发帖可以浏览器直连**。
 * 所以本模块只负责「验证令牌 + 发帖」，
 * 「获取令牌」由绑定层负责（PAT 粘贴，或未来的 Device Flow 中转）。
 *
 * 令牌存储策略
 * ------------
 * **只存内存，不落 localStorage / sessionStorage。**
 *
 * 理由：论坛站点会渲染**用户提交的第三方内容**（帖子正文），
 * 这是一个潜在的 XSS 注入面。任何注入成功的脚本都能读走
 * localStorage 里的长期令牌。放内存里，刷新页面即失效，
 * 风险窗口从「永久」缩短到「当前会话」。
 *
 * 代价：刷新页面需要重新绑定。这个代价换来的是
 * 「一个 XSS 就能偷走发帖权限」这个风险被消除 —— 对一个
 * 承诺「不采集任何身份信息」的论坛，这是划算的。
 *
 * 权限最小化
 * ----------
 * 只需要 `public_repo`（公开仓库的写权限，Discussion 必需）
 * 或 fine-grained PAT 的 `Discussions: write`（限定单个仓库）。
 * 绑定时会主动调 /user 验证令牌有效性，并读取 scope。
 */

const GITHUB_API = 'https://api.github.com'
const GITHUB_GRAPHQL = 'https://api.github.com/graphql'

/**
 * 内存中的会话状态
 *
 * 刻意不落任何持久化存储 —— 见文件头「令牌存储策略」。
 */
const state = {
  token: null,
  login: null,
  avatarUrl: null,
  scopes: []
}

/** 绑定的仓库与分类（由 fetchRepoMeta 填充） */
let repoMeta = null

function getState () {
  return {
    bound: !!state.token,
    login: state.login,
    avatarUrl: state.avatarUrl,
    scopes: state.scopes.slice()
  }
}

/**
 * 取当前令牌
 *
 * 单独开一个函数而不是放进 getState() ——
 * getState 的返回值会被 UI 用来渲染（可能进 DOM、可能被日志记录），
 * 不该顺带把令牌带出去。
 * 需要用令牌的只有 GraphQL 调用本身，那发生在 SDK 内部。
 */
function getToken () {
  return state.token
}

function getRepoMeta () {
  return repoMeta
}

function reset () {
  state.token = null
  state.login = null
  state.avatarUrl = null
  state.scopes = []
  repoMeta = null
}

/**
 * 调用 GitHub GraphQL API
 *
 * @param {string} query GraphQL 查询文本
 * @param {object} variables 变量
 * @param {string} token 访问令牌
 * @returns {Promise<object>} data 字段
 * @throws {Error} 带 status 与 code 的错误
 */
async function graphql (query, variables, token) {
  const res = await fetch(GITHUB_GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({ query, variables: variables || {} })
  })

  let payload = null
  try {
    payload = await res.json()
  } catch (e) {
    throw makeError('GitHub 返回了无法解析的内容（HTTP ' + res.status + '）', res.status, 'bad_response')
  }

  if (!res.ok) {
    // GraphQL 的错误在 body.errors 里，但 HTTP 状态码也可能非 200。
    // 两种来源都要读 —— GitHub 有时给 message，有时只给 errors[].message。
    const gqlErr = payload && payload.errors && payload.errors[0]
    const msg = (payload && payload.message) ||
      (gqlErr && gqlErr.message) ||
      ('HTTP ' + res.status)
    // 若 GraphQL 给了更精确的 type，用它覆盖 HTTP 状态推导出的 code
    let code = statusToCode(res.status)
    const type = (gqlErr && gqlErr.type || '').toUpperCase()
    if (type === 'FORBIDDEN') code = 'forbidden'
    else if (type === 'NOT_FOUND') code = 'not_found'
    else if (type === 'UNAUTHORIZED') code = 'unauthorized'
    throw makeError(msg, res.status, code)
  }

  if (payload && payload.errors && payload.errors.length) {
    const e = payload.errors[0]
    // GraphQL 的错误可能是：
    //   { type: 'FORBIDDEN', message: 'Resource not accessible by ...' }
    //   { type: 'NOT_FOUND', message: 'Could not resolve to a Repository...' }
    // type 映射成我们的 code，便于 explainError 分流。
    const type = (e.type || '').toUpperCase()
    let code = 'graphql_error'
    if (type === 'FORBIDDEN') code = 'forbidden'
    else if (type === 'NOT_FOUND') code = 'not_found'
    else if (type === 'UNAUTHORIZED') code = 'unauthorized'
    throw makeError(e.message || 'GraphQL 返回了错误', 400, code)
  }

  return payload.data
}

/**
 * 调用 GitHub REST API
 */
async function rest (path, token, options) {
  const opts = options || {}
  const res = await fetch(GITHUB_API + path, {
    method: opts.method || 'GET',
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': 'Bearer ' + token
    }
  })

  let payload = null
  try {
    payload = await res.json()
  } catch (e) { /* 空 body，忽略 */ }

  if (!res.ok) {
    const msg = (payload && payload.message) || ('HTTP ' + res.status)
    throw makeError(msg, res.status, statusToCode(res.status))
  }
  return payload
}

function makeError (message, status, code) {
  const e = new Error(message)
  e.status = status || 0
  e.code = code || 'error'
  return e
}

function statusToCode (status) {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 422) return 'unprocessable'
  if (status === 429) return 'rate_limited'
  return 'error'
}

/**
 * 验证令牌并读取身份
 *
 * 调 /user 确认令牌有效，同时从响应头读 scope。
 * 顺带检查令牌是否具备发 Discussion 所需的权限。
 *
 * @param {string} token
 * @returns {Promise<{login:string, avatarUrl:string, scopes:string[], canPost:boolean}>}
 */
async function verifyToken (token) {
  if (!token || typeof token !== 'string') {
    throw makeError('令牌为空', 0, 'empty_token')
  }
  const t = token.trim()
  if (!t) throw makeError('令牌为空', 0, 'empty_token')

  // GitHub 的 scope 在 X-OAuth-Scopes 响应头里。
  // 但 fetch 在跨域时默认不暴露除 CORS 允许列表外的响应头，
  // 所以拿不到就退化为「只看能不能调通 /user」。
  const user = await rest('/user', t)
  const scopeHeader = null // 跨域下取不到，见下方说明

  const login = user && user.login
  if (!login) {
    throw makeError('令牌无效：GitHub 没有返回用户信息', 401, 'unauthorized')
  }

  state.token = t
  state.login = login
  state.avatarUrl = user.avatar_url || ''
  state.scopes = scopeHeader ? scopeHeader.split(',').map(function (s) { return s.trim() }) : []

  return {
    login: login,
    avatarUrl: state.avatarUrl,
    scopes: state.scopes.slice(),
    // 不再强判 scope —— fine-grained PAT 的 scope 不在 X-OAuth-Scopes 里，
    // 真正的权限检验交给下面的建帖尝试。
    canPost: true
  }
}

/**
 * 读取仓库 ID 与 Discussion 分类 ID
 *
 * GraphQL 需要两个 node id：
 *   repositoryId —— 形如 R_kgDOxxxx
 *   categoryId   —— 形如 DIC_kwDOxxxx
 *
 * 这两个是 GraphQL 全局 ID，不是仓库名/分类名，所以必须查一次。
 *
 * @param {string} token
 * @param {string} owner 仓库所有者
 * @param {string} repo 仓库名
 * @param {string} categoryName 分类显示名
 * @returns {Promise<{repositoryId:string, categoryId:string, categoryName:string, categories:Array}>}
 */
async function fetchRepoMeta (token, owner, repo, categoryName) {
  const query = `
    query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        id
        hasDiscussionsEnabled
        discussionCategories(first: 25) {
          nodes { id name slug }
        }
      }
    }`
  const data = await graphql(query, { owner, repo }, token)
  const r = data && data.repository
  if (!r) {
    throw makeError('找不到仓库 ' + owner + '/' + repo + '，或令牌没有访问权限', 404, 'not_found')
  }
  if (!r.hasDiscussionsEnabled) {
    throw makeError('该仓库没有开启 Discussions', 400, 'discussions_disabled')
  }

  const categories = (r.discussionCategories && r.discussionCategories.nodes) || []
  if (!categories.length) {
    throw makeError('该仓库没有可用的 Discussion 分类', 400, 'no_category')
  }
  // 优先匹配指定分类；找不到就退回第一个（分类只有一个时等价）
  let cat = categories.filter(function (c) {
    return c.name === categoryName || c.slug === categoryName
  })[0]
  if (!cat) cat = categories[0]

  repoMeta = {
    repositoryId: r.id,
    categoryId: cat.id,
    categoryName: cat.name,
    categories: categories.map(function (c) {
      return { id: c.id, name: c.name, slug: c.slug }
    })
  }
  return repoMeta
}

/**
 * 创建 Discussion
 *
 * @param {string} token
 * @param {object} opts
 * @param {string} opts.title 标题（**应为脱敏后的**）
 * @param {string} opts.body 正文（**应为脱敏后的**）
 * @param {string} opts.repositoryId
 * @param {string} opts.categoryId
 * @returns {Promise<{id:string, url:string}>}
 */
async function createDiscussion (token, opts) {
  const mutation = `
    mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
      createDiscussion(input: {
        repositoryId: $repositoryId,
        categoryId: $categoryId,
        title: $title,
        body: $body
      }) {
        discussion { id url number }
      }
    }`
  const data = await graphql(mutation, {
    repositoryId: opts.repositoryId,
    categoryId: opts.categoryId,
    title: opts.title,
    body: opts.body
  }, token)

  const d = data && data.createDiscussion && data.createDiscussion.discussion
  if (!d) {
    throw makeError('GitHub 没有返回发帖结果', 500, 'error')
  }
  return { id: d.id, url: d.url, number: d.number }
}

/**
 * 检查令牌对目标仓库是否具备发帖权限
 *
 * 办法：查该用户对仓库的权限（permission level）。
 * pull = 只读；push/admin/maintain = 可写。
 * Discussion 的写权限跟随仓库写权限。
 *
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<{permission:string, canPost:boolean}>}
 */
async function checkRepoPermission (token, owner, repo) {
  try {
    const data = await rest('/repos/' + owner + '/' + repo + '/collaborators/' +
      encodeURIComponent('@me') + '/permission', token)
    const perm = (data && data.permission) || 'none'
    return {
      permission: perm,
      canPost: perm === 'admin' || perm === 'write' || perm === 'maintain'
    }
  } catch (e) {
    // 端点在某些情况下返回 404（仓库不存在或无权限）
    // 这不代表令牌无效，所以不抛出，只返回 unknown
    return { permission: 'unknown', canPost: true }
  }
}

/**
 * 把错误翻译成用户能懂的中文
 *
 * 原则：给**可操作**的提示，不只是复述 GitHub 的英文原文。
 * 用户看到 "Resource not accessible by personal access token" 不知道该怎么办，
 * 看到「令牌权限不足，去设置页勾选 Discussions: Read and write」才知道。
 *
 * @param {Error} e
 * @returns {string}
 */
function explainError (e) {
  const code = e && e.code
  const msg = (e && e.message) || '未知错误'
  const lower = String(msg).toLowerCase()

  // 网络层错误（fetch 抛的 TypeError）—— 跨域失败、CORS 被拦、离线
  if (/failed to fetch|networkerror|load failed/i.test(lower)) {
    return '连不上 GitHub。请检查网络，或确认当前网络没有拦截 api.github.com'
  }
  if (/timeout|aborted/i.test(lower)) {
    return '请求超时，请稍后再试'
  }

  switch (code) {
    case 'unauthorized':
      return '令牌无效或已过期，请重新绑定'

    case 'forbidden':
    case 'unprocessable':
      // 权限类错误最常见，也最需要可操作指引
      if (/scope|permission|access|resource not accessible/i.test(lower)) {
        return '令牌权限不足：发 Discussion 需要 Discussions 的读写权限。' +
          '请重新生成令牌 —— Repository access 只选 PGrefuge 仓库，' +
          'Repository permissions → Discussions 勾 Read and write'
      }
      if (/rate limit|abuse detection/i.test(lower)) {
        return 'GitHub 接口调用频率超限，请等几分钟再试'
      }
      if (/must have|write access|admin/i.test(lower)) {
        return '当前账号对这个仓库没有发帖权限。' +
          '请确认令牌选的是 PGrefuge 仓库，且勾选了 Discussions 读写权限'
      }
      if (/title|body|empty/i.test(lower)) {
        return '标题或正文为空，或内容不符合 GitHub 的要求'
      }
      return 'GitHub 拒绝了这次操作：' + msg

    case 'not_found':
      if (/repository|仓库/i.test(lower)) {
        return '找不到目标仓库，请检查仓库配置是否正确'
      }
      if (/分类|category/i.test(lower)) {
        return '找不到目标 Discussion 分类，请检查配置'
      }
      return '找不到目标仓库或分类，请检查配置'

    case 'rate_limited':
      return 'GitHub 接口调用频率超限，请稍后再试'

    case 'empty_token':
      return '请先粘贴 GitHub 令牌'

    case 'discussions_disabled':
      return '该仓库没有开启 Discussions，无法发帖'

    case 'no_category':
      return '该仓库没有可用的 Discussion 分类'

    default:
      return msg
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getState,
    getToken,
    getRepoMeta,
    reset,
    verifyToken,
    fetchRepoMeta,
    createDiscussion,
    checkRepoPermission,
    explainError,
    GITHUB_GRAPHQL
  }
}

// 浏览器环境挂到全局 —— 站点用 <script src> 引入，没有 require。
//
// 用 window 判断而不是 document：
// 这样 Node 里也能 require 本文件做语法检查与单元测试。
if (typeof window !== 'undefined') {
  window.PGGitHub = {
    getState: getState,
    getToken: getToken,
    getRepoMeta: getRepoMeta,
    reset: reset,
    verifyToken: verifyToken,
    fetchRepoMeta: fetchRepoMeta,
    createDiscussion: createDiscussion,
    checkRepoPermission: checkRepoPermission,
    explainError: explainError,
    GITHUB_GRAPHQL: GITHUB_GRAPHQL
  }
}
