#!/usr/bin/env node
/**
 * 仓库重建 —— 清除服务端残留的不可达对象（最后手段）
 *
 * 为什么需要它
 * ------------
 * 前面做过 filter-repo 重写 + force push + 删分支重建，
 * 但 GitHub 的后台 GC 是异步的，旧对象仍能按 SHA 从 raw / trees API 下载。
 *
 * 已实测无效的手段：
 *   - 转 private      → raw 仍 200
 *   - 改名             → 旧名 301 重定向，对象跟着仓库走
 *   - POST /git/gc     → 404，没有这个 API
 *   - DELETE blobs     → 404，没有这个 API
 *   - 删分支重建       → 断开引用，但对象仍在服务器上
 *
 * ⚠️ 重要前提（读 docs/sensitive-info-guard.md 第五节的反对意见）
 * --------------------------------------------------------------
 * 官方/社区更推荐让 GitHub Support 在「现有仓库」上跑 GC，因为删库会连带
 * 丢掉 wiki、issues、评论、stars、Actions 记录与仓库设置。
 * 本脚本只适用于「Support 入口走不通 + 仓库没有真实内容」的情形。
 *
 * 2026-11-08 本仓库已实测：删库后 raw 404 / trees 422，同名重建后仍 404，
 * 「立刻失效」成立。脚本末尾依然会实测验证，不把推断当结果。
 *
 * 已知无法自动化的部分：Discussion 分类。GitHub 没有创建分类的公开 API
 * （REST 404、GraphQL 无 createDiscussionCategory），只能网页手动建；
 * sync.js 已做分类缺失自动回退，站点不会因此坏掉。
 *
 * 用法
 * ----
 *   node scripts/recreate-repo.js --dry-run          # 只清点，绝不动手
 *   node scripts/recreate-repo.js --confirm-delete   # 执行（需 token 有 delete_repo）
 *
 * 若 token 没有 delete_repo scope（当前就是这种情况），脚本会打印网页删除
 * 指引并退出。你在网页删完后**直接重跑同一条命令即可**：
 * 脚本会自动检测到仓库已不存在，跳过删除，从「重建」那一步继续。
 */

'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')
const { execFileSync, execSync, spawnSync } = require('child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const DRY_RUN = process.argv.includes('--dry-run')
const CONFIRM_DELETE = process.argv.includes('--confirm-delete')

// 按当前线上仓库的实际设置还原，避免重建后行为变化
const CONFIG = {
  owner: 'm34571581-blip',
  repo: 'pgrefuge-forum',
  description: 'Share your experience anonymously. The system will automatically anonymize it.',
  homepage: 'https://m34571581-blip.github.io/pgrefuge-forum/',
  has_issues: true,
  has_projects: true,
  has_wiki: true,
  has_discussions: true
}

const FULL = `${CONFIG.owner}/${CONFIG.repo}`

// 重建后要恢复的 Discussions 分类（sync.yml 依赖这些 slug）
const DISCUSSION_CATEGORIES = [
  { name: 'experiences', description: '经历与处境分享' },
  { name: 'questions', description: '提问与讨论' },
  { name: 'resources', description: '资源与信息' }
]

// 污染提交里的一个已知可下载对象，用来验证清理是否真的生效
const POLLUTED_URL =
  `https://raw.githubusercontent.com/${FULL}/` +
  '936648099d0748e8834cb65e8234b138b9e58be3/docs/.wrangler/cache/cf.json'

let GH_TOKEN = ''

function sleep (ms) {
  return new Promise(r => setTimeout(r, ms))
}

function section (t) {
  console.log('\n' + '─'.repeat(64))
  console.log('  ' + t)
  console.log('─'.repeat(64))
}

function run (cmd) {
  return execSync(cmd, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/**
 * 凭据自动解析：优先环境变量，其次 git credential helper。
 * 原版强制要求 GH_USER/GH_TOKEN，但本机凭据实际存在 Windows 凭据管理器里，
 * 导致脚本一跑就退出。这里改成自动兜底。
 */
function resolveCredentials () {
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
  let source = '环境变量'

  if (!token) {
    try {
      const out = execFileSync('git', ['credential', 'fill'], {
        cwd: REPO_ROOT,
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8'
      })
      const kv = {}
      out.trim().split(/\r?\n/).forEach(line => {
        const i = line.indexOf('=')
        if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1)
      })
      token = kv.password || ''
      source = 'git credential helper（用户 ' + (kv.username || '?') + '）'
    } catch (e) {
      source = '获取失败：' + e.message
    }
  }

  if (!token) {
    console.error('✗ 拿不到 GitHub 凭据。请设置 GH_TOKEN，或先配置 git credential helper。')
    process.exit(2)
  }
  GH_TOKEN = token
  console.log('  凭据来源：' + source)
  console.log('  scope 提示：DELETE 仓库需要 delete_repo，缺失时脚本会给出网页删除指引')
}

/**
 * 统一走 Node https，避免 curl 在 Windows/Git Bash 下的引号转义问题。
 * 连接层抖动（TLS 断开、超时）自动重试；HTTP 错误不重试。
 * DELETE 不重试 —— 重复删除会拿到 404 并被误判成「需要网页删除」。
 */
function api (method, apiPath, body) {
  const maxAttempts = method === 'DELETE' ? 1 : 3
  const payload = body ? JSON.stringify(body) : null

  return new Promise((resolve, reject) => {
    const attempt = n => {
      let settled = false
      const fail = err => {
        if (settled) return
        if (n < maxAttempts) {
          settled = true
          setTimeout(() => attempt(n + 1), 800 * n)
        } else {
          settled = true
          reject(err)
        }
      }
      const headers = {
        'User-Agent': 'pgrefuge-recreate-repo',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + GH_TOKEN
      }
      if (payload) {
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = Buffer.byteLength(payload)
      }
      const req = https.request({ host: 'api.github.com', path: apiPath, method, headers }, res => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', d => { buf += d })
        res.on('end', () => {
          if (settled) return
          settled = true
          let data
          try {
            data = buf ? JSON.parse(buf) : {}
          } catch (e) {
            data = { message: buf.slice(0, 200) }
          }
          resolve({ status: res.statusCode, data })
        })
      })
      req.on('error', fail)
      req.setTimeout(20000, () => { req.destroy(new Error('request timeout')) })
      if (payload) req.write(payload)
      req.end()
    }
    attempt(1)
  })
}

/** 只取状态码，不读取、不打印被污染的文件内容 */
function httpStatus (url) {
  return new Promise(resolve => {
    const u = new URL(url)
    const req = https.request({
      host: u.host,
      path: u.pathname,
      method: 'GET',
      headers: { 'User-Agent': 'pgrefuge-recreate-repo' }
    }, res => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', () => resolve(0))
    req.setTimeout(15000, () => { req.destroy(); resolve(0) })
    req.end()
  })
}

/** 清点仓库里是否有不可重建的用户内容 */
async function inventory () {
  const counts = {}
  for (const [name, ep] of [
    ['issues', 'issues?state=all&per_page=100'],
    ['PR', 'pulls?state=all&per_page=100'],
    ['stars', 'stargazers?per_page=100'],
    ['forks', 'forks?per_page=100'],
    ['releases', 'releases?per_page=100'],
    ['actions runs', 'actions/runs?per_page=100']
  ]) {
    const r = await api('GET', `/repos/${FULL}/${ep}`)
    counts[name] = Array.isArray(r.data) ? r.data.length : (r.data.total_count ?? 'n/a')
  }
  // REST 没有 discussions 列表端点，用 GraphQL 单独统计
  const gql = await api('POST', '/graphql', {
    query: `query($owner:String!,$name:String!){
      repository(owner:$owner,name:$name){ discussions{totalCount} }
    }`,
    variables: { owner: CONFIG.owner, name: CONFIG.repo }
  })
  counts.discussions = gql.data?.data?.repository?.discussions?.totalCount ?? 'n/a'

  console.log('  内容统计：')
  for (const [k, v] of Object.entries(counts)) {
    console.log(`    ${k.padEnd(14)} ${v}`)
  }
  const nonEmpty = Object.entries(counts)
    .filter(([k, v]) => v !== 0 && v !== 'n/a' && k !== 'actions runs')
  return { counts, nonEmpty }
}

/**
 * 检查 Discussions 分类是否齐全。
 * GitHub **没有**创建分类的公开 API：REST /repos/.../discussions/categories
 * 实测 404，GraphQL 也没有 createDiscussionCategory mutation（实测报字段不存在）。
 * 所以只能检测 + 给网页指引，不要假装能自动创建。
 * sync.js 已做「分类缺失自动回退到 General」，站点不会因此坏掉。
 */
async function checkCategories () {
  const gql = await api('POST', '/graphql', {
    query: `query($owner:String!,$name:String!){
      repository(owner:$owner,name:$name){ discussionCategories(first:50){ nodes{ name slug } } }
    }`,
    variables: { owner: CONFIG.owner, name: CONFIG.repo }
  })
  const cats = gql.data?.data?.repository?.discussionCategories?.nodes || []
  const existing = cats.map(c => c.name)
  const missing = DISCUSSION_CATEGORIES.filter(c => existing.indexOf(c.name) === -1)

  console.log('  现有分类：' + (cats.map(c => c.name).join('、') || '（读取失败）'))
  if (!missing.length) {
    console.log('  ✓ 目标分类齐全，无需操作')
    return
  }
  console.log('')
  console.log('  缺少：' + missing.map(c => c.name).join('、'))
  console.log('  GitHub 未提供创建分类的公开 API，这 ' + missing.length + ' 个需要网页手动创建。')
  console.log('  站点已由 sync.js 自动回退到 General，不创建也能正常发帖/展示。')
  printCategoryGuide(missing)
}

function printCategoryGuide (cats) {
  console.log('')
  console.log('  ── 手动创建路径 ──')
  console.log(`  https://github.com/${FULL}/discussions/categories → New category`)
  ;(cats || DISCUSSION_CATEGORIES).forEach(c => {
    console.log(`    name: ${c.name}   description: ${c.description}`)
    console.log('    format: Open-ended discussion（选它，便于回帖）')
  })
  console.log('  建好后下次同步会自动切回，无需改代码。')
}

async function main () {
  section('0. 凭据')
  resolveCredentials()

  // 先判断仓库是否还在 —— 网页删除后续跑的关键
  const probe = await api('GET', `/repos/${FULL}`)
  const repoExists = probe.status === 200
  console.log('\n  仓库状态：' + (repoExists ? '存在' : `不存在（HTTP ${probe.status}）`))

  if (repoExists) {
    section('1. 重建前清点（决定要不要重建）')
    const { nonEmpty } = await inventory()
    if (nonEmpty.length) {
      console.error('')
      console.error('  ✗ 仓库里有真实内容，重建会丢失：')
      nonEmpty.forEach(([k, v]) => console.error(`      ${k}: ${v}`))
      console.error('    请先人工确认这些内容是否可以丢弃。')
      process.exit(1)
    }
    console.log('  → 无用户内容，重建代价接近零')

    section('2. 本地状态检查')
    const st = run('git status --porcelain')
    if (st.trim()) {
      console.error('  ✗ 工作区有未提交改动，先提交或 stash')
      process.exit(1)
    }
    const head = run('git rev-parse HEAD').trim()
    const branch = run('git rev-parse --abbrev-ref HEAD').trim()
    console.log(`  分支 ${branch} @ ${head.slice(0, 12)}`)
    console.log('  → 工作区干净')

    section('3. 确认本地无污染对象')
    const hist = spawnSync(process.execPath, ['scripts/check-sensitive-history.js'], {
      cwd: REPO_ROOT, encoding: 'utf8'
    })
    if (hist.status !== 0) {
      console.error('  ✗ 本地历史仍有敏感内容，先用 filter-repo 清理')
      console.log((hist.stdout || '').split('\n').slice(0, 15).join('\n'))
      process.exit(1)
    }
    console.log('  → 本地历史干净')

    section('4. 删除前备份')
    const backup = path.join(REPO_ROOT, '..', `pgrefuge-forum-backup-${Date.now()}`)
    console.log(`  备份到 ${backup}`)
    if (!DRY_RUN && CONFIRM_DELETE) {
      run(`cp -r "${REPO_ROOT}" "${backup}"`)
      console.log('  ✓ 已备份（含 .git 全部历史）')
    } else {
      console.log('  (dry-run 或未确认删除，跳过)')
    }

    if (DRY_RUN) {
      section('DRY RUN —— 不会执行任何破坏性操作')
      console.log('  确认执行后会依次做：')
      console.log(`    1. DELETE /repos/${FULL}（不可逆，需 --confirm-delete）`)
      console.log('    2. 用同名重建空仓库，还原 issues/wiki/projects/discussions 开关')
      console.log('    3. force push 本地干净历史')
      console.log('    4. 检查 Discussions 分类（缺失时给网页指引）、启用 Pages、触发部署')
      console.log('    5. 自动验证旧链接是否 404（不把推断当结果）')
      console.log('')
      console.log('  若 token 无 delete_repo：脚本会停下并给网页删除指引，删完重跑同一命令即可续跑。')
      return
    }

    if (!CONFIRM_DELETE) {
      console.error('')
      console.error('  ⚠️ 删除仓库不可恢复。确认要执行请加 --confirm-delete：')
      console.error('     node scripts/recreate-repo.js --confirm-delete')
      process.exit(4)
    }

    section('5. 删除旧仓库')
    const del = await api('DELETE', `/repos/${FULL}`)
    if (del.status === 204 || del.status === 200) {
      console.log('  ✓ 已通过 API 删除')
    } else {
      console.log(`  API 删除失败（HTTP ${del.status}）—— 需要你在网页手动删除：`)
      console.log('')
      console.log(`    1) 打开 https://github.com/${FULL}/settings`)
      console.log('    2) 滚到最下方 Danger Zone → Delete this repository')
      console.log('    3) 按提示输入仓库名确认')
      console.log('')
      console.log('  ⚠️ 删完后**重跑同一条命令**，脚本会自动检测到仓库不存在并继续重建。')
      console.log('  原因：' + (del.data?.message || 'token 缺少 delete_repo scope'))
      process.exit(3)
    }
  } else {
    section('1–5. 仓库已删除，跳过清点与删除，直接进入重建')
    if (DRY_RUN) {
      console.log('  (dry-run) 非 dry-run 时会：重建仓库 → 推送历史 → 恢复设置 → 验证旧链接')
      return
    }
  }

  section('6. 重建同名仓库')
  let created = null
  for (let i = 0; i < 10; i++) {
    const r = await api('POST', '/user/repos', {
      name: CONFIG.repo,
      description: CONFIG.description,
      homepage: CONFIG.homepage,
      private: false,
      has_issues: CONFIG.has_issues,
      has_projects: CONFIG.has_projects,
      has_wiki: CONFIG.has_wiki,
      has_discussions: CONFIG.has_discussions,
      auto_init: false
    })
    if (r.data?.full_name) { created = r.data; break }
    console.log(`  第 ${i + 1} 次创建未成功（${r.data?.message || r.status}），5 秒后重试…`)
    await sleep(5000)
  }
  if (!created) {
    console.error('  ✗ 重建失败，请检查仓库名占用或 token 权限')
    process.exit(1)
  }
  console.log('  ✓ 已重建：' + created.full_name)
  if (created.full_name !== FULL) {
    console.error('  ✗ 名字不符，停止以避免推错仓库')
    process.exit(1)
  }

  section('7. 推送干净历史')
  const branch = run('git rev-parse --abbrev-ref HEAD').trim()
  run(`git remote set-url origin "https://github.com/${FULL}.git"`)
  run('git push -u --force origin ' + branch)
  console.log('  ✓ 已推送')

  section('8. 检查 Discussions 分类')
  await checkCategories()

  section('9. 启用 Pages（workflow 构建）')
  const pages = await api('POST', `/repos/${FULL}/pages`, { build_type: 'workflow' })
  console.log('  ' + (pages.data?.html_url || pages.data?.message || `HTTP ${pages.status}`))

  section('10. 触发部署')
  const dispatch = await api('POST', `/repos/${FULL}/actions/workflows/sync.yml/dispatches`, { ref: branch })
  console.log('  ' + (dispatch.status === 204 ? '✓ 已触发，等 1–2 分钟' : `HTTP ${dispatch.status}（push 本身也会触发工作流）`))

  section('11. 验证旧链接是否真的失效')
  let finalCode = 0
  for (let i = 0; i < 6; i++) {
    finalCode = await httpStatus(POLLUTED_URL)
    if (finalCode === 404) break
    if (i < 5) await sleep(5000)
  }
  if (finalCode === 404) {
    console.log('  ✓ 旧对象已 404 —— 清理生效')
  } else {
    console.log(`  ⚠️ 旧对象仍返回 HTTP ${finalCode}（0 = 网络错误）。`)
    console.log('     说明删库重建未能立即阻断，或 CDN 缓存尚未过期。')
    console.log('     请隔一段时间重测，并考虑走 GitHub Support / Community 请官方跑 GC。')
  }
  console.log('\n  验证地址（只取状态码，不下载内容）：')
  console.log('  ' + POLLUTED_URL)
}

main().catch(e => {
  console.error('\n✗ 失败:', e && e.message ? e.message : e)
  process.exit(1)
})
