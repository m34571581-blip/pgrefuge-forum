/**
 * 论坛数据同步管道
 *
 * 数据流：
 *   GitHub Discussions ──GraphQL──▶ 原始帖子
 *        │
 *        ├─▶ 脱敏（scripts/desensitize.js）──▶ 公开数据
 *        ├─▶ 匿名代号分配 ──▶ 替换掉 GitHub 用户名
 *        └─▶ 结构化 JSON ──▶ site/posts.json
 *
 * 为什么脱敏在「发布前」而不是「展示时」：
 * 脱敏后的内容才允许出现在静态站和数据集里。
 * 原始内容始终留在 GitHub Discussions（那是私密讨论区，需要登录才能看）。
 *
 * 用法：
 *   GITHUB_TOKEN=xxx node scripts/sync.js            # 拉取并生成
 *   node scripts/sync.js --offline                    # 用本地缓存（无网络时）
 */

const fs = require('fs')
const path = require('path')
const { desensitize, summarize } = require('./desensitize')

const ROOT = path.resolve(__dirname, '..')
const DATA_DIR = path.join(ROOT, 'data')
const SITE_DIR = path.join(ROOT, 'site')

// ---- 配置 ----
const OWNER = process.env.GH_OWNER || 'your-username'
const REPO = process.env.GH_REPO || 'pgrefuge-forum'
// 目标分类名。技术参数一律用英文。
const CATEGORY = process.env.GH_CATEGORY || 'experiences'
// 兼容旧分类名：改名过渡期两边都要能拉到，避免同步断档。
// 用 GH_CATEGORY_ALIASES 覆盖，默认只认主分类名。
const CATEGORY_ALIASES = (process.env.GH_CATEGORY_ALIASES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const TOKEN = process.env.GITHUB_TOKEN || ''

/**
 * 是否把脱敏后的内容覆写回 GitHub 原帖。
 *
 * 默认开启 —— 仓库是公开的，Discussions 原文对未登录访客可见，
 * 只在静态站脱敏等于没脱敏。关掉它就等于承认「隐私承诺是假的」。
 *
 * 需要 token 具备 discussions: write 权限。
 */
const OVERWRITE_ORIGINAL = process.env.GH_OVERWRITE_ORIGINAL !== 'false'

/** 分类标签 → 产品内的类型标签 */
const TAG_MAP = {
  '压榨': '压榨',
  'PUA': 'PUA',
  '谩骂': '谩骂',
  '人格污蔑': '人格污蔑',
  'Push': 'Push',
  '其他': '其他'
}

/** 分类标签 → 评论区引导的应对策略 */
const STRATEGY_MAP = {
  '压榨': 'reduce',
  'PUA': 'escape',
  '谩骂': 'transfer',
  '人格污蔑': 'avoid',
  'Push': 'reduce',
  '其他': 'avoid'
}

/** 匿名代号池 —— 诗意代号，与小程序端保持一致的调性 */
const ALIASES = [
  '晚风', '旧书页', '雨巷', '青柠', '山雀', '纸飞机', '南墙', '白露',
  '橘子汽水', '抽屉', '单车', '雾灯', '麦田', '候鸟', '沙漏', '铜钥匙',
  '棉花糖', '路灯', '素描', '汽水', '布丁', '风筝', '指南针', '海浪',
  '木吉他', '橘子', '月光', '台灯', '火车票', '玻璃糖', '柠檬', '蒲公英',
  '橡皮', '邮筒', '星星糖', '耳机', '云朵', '曲奇', '手电筒', '书签'
]

const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql'

/** 拉取 Discussions（含评论） */
async function fetchDiscussions() {
  if (!TOKEN) {
    throw new Error(
      '缺少 GITHUB_TOKEN。GraphQL API 必须认证 —— 匿名请求会返回 Bad credentials。\n' +
      '创建方式：GitHub → Settings → Developer settings → Personal access tokens →\n' +
      '  Fine-grained token → 勾选 Discussions: Read-only → 生成'
    )
  }

  const query = `
    query($owner: String!, $repo: String!, $first: Int!) {
      repository(owner: $owner, name: $repo) {
        discussionCategories(first: 25) {
          nodes { id name slug }
        }
        discussions(first: $first, orderBy: {field: CREATED_AT, direction: DESC}) {
          totalCount
          nodes {
            id
            number
            title
            body
            createdAt
            url
            category { name }
            author { ... on User { login } }
            comments(first: 100) {
              totalCount
              nodes {
                id
                body
                createdAt
                author { ... on User { login } }
                reactions { totalCount }
              }
            }
          }
        }
      }
    }
  `

  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
      'User-Agent': 'pgrefuge-sync'
    },
    body: JSON.stringify({ query, variables: { owner: OWNER, repo: REPO, first: 100 } })
  })

  const json = await res.json()
  if (!res.ok) {
    throw new Error('GitHub API HTTP ' + res.status + ': ' + JSON.stringify(json).slice(0, 300))
  }
  if (json.errors) {
    throw new Error('GraphQL 错误: ' + JSON.stringify(json.errors).slice(0, 400))
  }
  return json.data.repository
}

/**
 * 把脱敏后的内容覆写回 GitHub
 *
 * 为什么必须这么做：
 *   仓库是公开的，Discussions 的内容对未登录访客完全可见。
 *   如果只把脱敏结果放进静态站，原文仍然躺在 GitHub 上 ——
 *   「服务端强制脱敏、不采集任何身份信息」这个承诺就是假的。
 *
 *   所以同步时把脱敏后的正文写回原帖，让 GitHub 上展示的就是脱敏版。
 *   原始内容只短暂存在于同步之前的那段时间。
 *
 * 注意：需要 discussions: write 权限（GITHUB_TOKEN 默认带）。
 */
async function overwriteOnGitHub(items) {
  if (!items.length) return { updated: 0, failed: 0 }

  const mutation = `
    mutation($discussionId: ID!, $body: String!) {
      updateDiscussion(input: {discussionId: $discussionId, body: $body}) {
        discussion { id url updatedAt }
      }
    }
  `

  let updated = 0
  let failed = 0

  for (const item of items) {
    try {
      const res = await fetch(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
          'User-Agent': 'pgrefuge-sync'
        },
        body: JSON.stringify({
          query: mutation,
          variables: { discussionId: item.id, body: item.body }
        })
      })
      const json = await res.json()
      if (json.errors) {
        failed++
        console.warn('  覆写失败 #' + item.number + ': ' + JSON.stringify(json.errors).slice(0, 160))
      } else {
        updated++
        console.log('  已覆写 #' + item.number + '（原文 → 脱敏版）')
      }
    } catch (e) {
      failed++
      console.warn('  覆写异常 #' + item.number + ': ' + String(e.message || e).slice(0, 160))
    }
  }
  return { updated, failed }
}

/** 从讨论标题里解析出用户填的标签与策略 */
function parseMeta(disc) {
  // 约定：用户在标题末尾用 [标签] 标注，正文首行用 > 策略: xxx
  const title = disc.title || ''
  const body = disc.body || ''

  const tagFromTitle = (title.match(/\[(.+?)\]/) || [])[1]
  const strategyFromBody = (body.match(/策略[:：]\s*(\w+)/) || [])[1]

  const tag = TAG_MAP[tagFromTitle] || '其他'
  const strategy = STRATEGY_MAP[tagFromTitle] || strategyFromBody || 'reduce'
  return { tag, strategy }
}

/**
 * 清洗标题：去掉 [标签] 标记和策略行
 * 这些是「给系统看的元数据」，不该出现在展示层
 */
function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*\[(.+?)\]/g, '')      // 去掉 [标签]
    .replace(/^\s*策略[:：].*$/gm, '')  // 去掉策略行
    .trim()
}

/**
 * 清洗正文：去掉策略行（那是给系统看的）
 * 但保留其余内容原样 —— 用户的表达不该被改写
 */
function cleanBody(body) {
  return String(body || '')
    .replace(/^\s*策略[:：]\s*\w+\s*$/gm, '')
    .replace(/^\s*策略[:：]\s*\w+\s*$/gm, '')
    .trim()
}

/** 稳定匿名代号：同一个 GitHub 用户永远映射到同一个代号 */
function buildAliasMap(discussions) {
  const logins = new Set()
  discussions.forEach((d) => {
    if (d.author && d.author.login) logins.add(d.author.login)
    ;(d.comments.nodes || []).forEach((c) => {
      if (c.author && c.author.login) logins.add(c.author.login)
    })
  })

  // 排序保证映射稳定（否则每次同步代号会变）
  const sorted = Array.from(logins).sort()
  const map = {}
  sorted.forEach((login, i) => {
    map[login] = ALIASES[i % ALIASES.length]
  })
  return map
}

/** 主流程 */
async function main() {
  const offline = process.argv.includes('--offline')
  let repoData

  if (offline) {
    const cache = path.join(DATA_DIR, '.raw-cache.json')
    if (!fs.existsSync(cache)) {
      console.error('离线模式但没有缓存文件:', cache)
      process.exit(1)
    }
    repoData = JSON.parse(fs.readFileSync(cache, 'utf8'))
    console.log('使用本地缓存')
  } else {
    console.log('拉取 GitHub Discussions ...')
    repoData = await fetchDiscussions()
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(DATA_DIR, '.raw-cache.json'),
      JSON.stringify(repoData, null, 2),
      'utf8'
    )
  }

  // 只保留目标分类下的主题。
  // GitHub Discussions 建仓时自带 General / Q&A / Ideas 等默认分类，
  // 如果不过滤，这些跟产品无关的内容会混进论坛数据里。
  // 别名用于分类改名过渡期 —— 新旧分类名同时认，避免同步断档。
  const acceptedNames = [CATEGORY, ...CATEGORY_ALIASES].filter(Boolean)
  const allDiscussions = repoData.discussions.nodes || []
  const discussions = acceptedNames.length
    ? allDiscussions.filter((d) => d.category && acceptedNames.indexOf(d.category.name) !== -1)
    : allDiscussions

  const aliases = buildAliasMap(discussions)

  console.log('原始主题数:', repoData.discussions.totalCount, '| 本次拉取:', allDiscussions.length)
  console.log(`分类「${acceptedNames.join('」/「')}」下的主题:`, discussions.length)
  console.log('参与用户数:', Object.keys(aliases).length)

  // 分类名写错是最容易犯也最难发现的错误 —— 静默返回 0 条，
  // 站点看起来就是「没人发帖」，很难联想到是分类名不对。
  if (acceptedNames.length && discussions.length === 0) {
    const cats = (repoData.discussionCategories && repoData.discussionCategories.nodes) || []
    console.warn('')
    console.warn('⚠ 没有拉到任何主题。可能原因：')
    console.warn(`  · 分类名「${acceptedNames.join('」「')}」在 GitHub 上不存在（名称必须完全一致）`)
    if (cats.length) {
      console.warn('  · GitHub 上现有的分类是：' + cats.map((c) => c.name).join('、'))
    }
    console.warn('  · 还没人在这个分类下发帖')
    console.warn('  在仓库的 Discussions 页新建分类，或改 workflow 里的 GH_CATEGORY')
    console.warn('')
  }

  // ---- 脱敏 + 组装 ----
  const posts = discussions.map((d) => {
    const { tag, strategy } = parseMeta(d)

    // 标题与正文都过脱敏
    // 先清洗元数据（[标签]、策略行），再脱敏 —— 顺序不能反，
    // 否则 [压榨] 里的方括号会干扰脱敏的标记解析
    const safeTitle = desensitize(cleanTitle(d.title)).content
    const safeBody = desensitize(cleanBody(d.body)).content
    const bodyHits = desensitize(cleanBody(d.body)).hits

    const comments = (d.comments.nodes || []).map((c) => {
      const r = desensitize(c.body || '')
      return {
        alias: aliases[c.author && c.author.login] || '匿名',
        content: r.content,
        createdAt: c.createdAt,
        reactions: c.reactions ? c.reactions.totalCount : 0
      }
    })

    return {
      id: d.id,
      number: d.number,
      title: safeTitle,
      content: safeBody,
      tag,
      strategy,
      alias: aliases[d.author && d.author.login] || '匿名',
      createdAt: d.createdAt,
      url: d.url,
      hitLabels: summarize(bodyHits),
      commentCount: d.comments.totalCount || comments.length,
      comments
    }
  })

  // ---- 覆写原帖：让 GitHub 上展示的就是脱敏版 ----
  //
  // 仓库是公开的，Discussions 原文对未登录访客可见。
  // 只在静态站脱敏是不够的 —— 原文必须被替换掉。
  //
  // 写回的内容格式与站内展示保持一致：策略行 + 脱敏正文。
  // 只有内容真的变了才覆写，避免每次同步都触发一次 edited 事件
  // （那会让 workflow 自己触发自己，形成循环）。
  if (!offline && OVERWRITE_ORIGINAL) {
    const toOverwrite = []
    for (const d of discussions) {
      const safeBody = desensitize(cleanBody(d.body)).content
      // 原文里可能带策略行，脱敏后要重新拼回去，否则覆写会把元数据抹掉
      const strategyLine = (d.body || '').match(/^\s*>+\s*策略[:：]\s*\w+\s*$/m)
      const newBody = strategyLine
        ? strategyLine[0] + '\n\n' + safeBody
        : safeBody
      if (newBody !== (d.body || '')) {
        toOverwrite.push({ id: d.id, number: d.number, body: newBody })
      }
    }
    if (toOverwrite.length) {
      console.log(`\n覆写 ${toOverwrite.length} 条原帖（脱敏后写回 GitHub）...`)
      const r = await overwriteOnGitHub(toOverwrite)
      console.log(`  成功 ${r.updated} 条，失败 ${r.failed} 条`)
      if (r.failed) {
        console.warn('  提示：覆写失败说明 token 缺少 discussions: write 权限，')
        console.warn('        或该帖已被锁定。GitHub 上仍会显示原文 —— 请手动处理。')
      }
    } else {
      console.log('\n所有原帖已是脱敏版，无需覆写')
    }
  }

  // ---- 统计（给作品集用的真实指标）----
  const stats = {
    totalPosts: posts.length,
    totalComments: posts.reduce((s, p) => s + p.commentCount, 0),
    uniqueAuthors: Object.keys(aliases).length,
    taggedCounts: {},
    strategyCounts: {},
    withSensitiveHits: posts.filter((p) => p.hitLabels.length > 0).length,
    firstPostAt: posts.length
      ? posts.map((p) => p.createdAt).sort()[0]
      : null,
    lastPostAt: posts.length
      ? posts.map((p) => p.createdAt).sort().slice(-1)[0]
      : null,
    generatedAt: new Date().toISOString()
  }

  // 把分类的真实 slug 一起输出。
  // 前端拼「写经历」链接时需要它 —— GitHub 的 /discussions/new?category=
  // 认的是 slug，而 ASCII 分类名的 slug 是小写转写（如 General → general），
  // 不能想当然用显示名。
  const cats = (repoData.discussionCategories && repoData.discussionCategories.nodes) || []
  // 优先取主分类的 slug；主分类还没建好时退回任一别名分类，
  // 保证过渡期链接也指向正确的分类。
  const targetCat =
    cats.find((c) => c.name === CATEGORY) ||
    cats.find((c) => acceptedNames.indexOf(c.name) !== -1)
  if (targetCat) {
    stats.categorySlug = targetCat.slug
    stats.categoryName = targetCat.name
  }
  posts.forEach((p) => {
    stats.taggedCounts[p.tag] = (stats.taggedCounts[p.tag] || 0) + 1
    stats.strategyCounts[p.strategy] = (stats.strategyCounts[p.strategy] || 0) + 1
  })

  // ---- 落盘 ----
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(SITE_DIR, { recursive: true })

  const payload = { stats, posts }
  fs.writeFileSync(
    path.join(DATA_DIR, 'posts.json'),
    JSON.stringify(payload, null, 2),
    'utf8'
  )
  fs.writeFileSync(
    path.join(SITE_DIR, 'posts.json'),
    JSON.stringify(payload, null, 2),
    'utf8'
  )

  // 生成浏览器版脱敏引擎到 site/ —— 供页面里的「发帖前预览」在浏览器本地跑。
  //
  // 为什么要自动生成而不是写死一份：
  // 预览用的规则必须和服务端跑的规则是同一份，否则会出现
  // 「预览显示已脱敏、实际发帖带真名」这种致命的不一致。
  // 由脚本自动打包，从机制上杜绝漂移。
  //
  // 现在引擎是多个 CommonJS 模块（desensitize / name-detector /
  // identifier-detector / name-dict.json），浏览器没有 require，
  // 所以要先用 build-browser-engine.js 打包成单文件再落盘。
  const engineSrc = path.join(__dirname, 'desensitize.js')
  const engineDst = path.join(SITE_DIR, 'desensitize.js')
  {
    const { execFileSync } = require('child_process')
    execFileSync(process.execPath, [path.join(__dirname, 'build-browser-engine.js')], {
      cwd: path.join(__dirname, '..'),
      stdio: 'pipe'
    })
  }

  console.log('\n已生成:')
  console.log('  data/posts.json   ', fs.statSync(path.join(DATA_DIR, 'posts.json')).size, 'bytes')
  console.log('  site/posts.json   ', fs.statSync(path.join(SITE_DIR, 'posts.json')).size, 'bytes')
  console.log('  site/desensitize.js', fs.statSync(engineDst).size, 'bytes（浏览器端脱敏引擎）')
  console.log('\n统计:')
  console.log('  帖子', stats.totalPosts, '| 评论', stats.totalComments,
    '| 参与者', stats.uniqueAuthors)
  console.log('  标签分布:', JSON.stringify(stats.taggedCounts))
  console.log('  策略分布:', JSON.stringify(stats.strategyCounts))
  console.log('  触发脱敏的帖子:', stats.withSensitiveHits, '/', stats.totalPosts)
}

main().catch((e) => {
  console.error('\n同步失败:', e.message)
  process.exit(1)
})
