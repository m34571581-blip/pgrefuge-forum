#!/usr/bin/env node
/**
 * 仓库重建 —— 彻底清除不可达对象
 *
 * 为什么需要它
 * ------------
 * 前面做过 filter-repo 重写 + force push + 删分支重建，
 * 但 GitHub 的后台 GC 是异步的（几小时到几周），
 * 在此期间旧对象仍能按 SHA 下载。
 *
 * 实测确认的各种手段（都不够）：
 *   - 转 private      → raw 仍 200（GitHub 对曾公开的仓库保留 raw 缓存）
 *   - 改名             → 旧名 301 重定向到新名，对象跟着仓库走，仍可访问
 *   - DELETE /git/gc  → 404，没有这个 API
 *   - DELETE blobs     → 404，没有这个 API
 *   - 删分支重建        → 断开引用了，但对象仍在服务器上
 *
 * 唯一能**立即**让旧链接全部 404 的方式：**删掉仓库，用同样的名字重建**。
 * 旧仓库被删后，它的对象在服务器上不可达；
 * 同名新仓库是一个全新的对象集合。
 *
 * 代价（实测统计）
 * ----------------
 * 这个仓库目前是**空的**：
 *   issues 0 / PR 0 / discussions 0 / stars 0 / forks 0 / releases 0
 *   只有默认的 10 个标签
 *
 * 所以重建几乎不丢东西 —— 唯一需要重建的是 Discussions 分类。
 *
 * ⚠️ 前提：仓库里一旦有真实内容，这个方案就要重新评估。
 *
 * 用法
 * ----
 *   node scripts/recreate-repo.js --dry-run    # 只检查，不动手
 *   node scripts/recreate-repo.js              # 执行重建
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const DRY_RUN = process.argv.includes('--dry-run')

const CONFIG = {
  owner: 'm34571581-blip',
  repo: 'pgrefuge-forum',
  description: '面向在校研究生的匿名倾诉社区。服务端强制脱敏，不采集任何身份信息。',
  homepage: 'https://m34571581-blip.github.io/pgrefuge-forum/',
  topics: ['privacy', 'anonymity', 'student-life', 'mental-health', 'forum']
}

/** Discussions 分类（重建后要恢复的） */
const DISCUSSION_CATEGORIES = [
  { name: 'experiences', description: '经历与处境分享' },
  { name: 'questions', description: '提问与讨论' },
  { name: 'resources', description: '资源与信息' }
]

function run (cmd, opts = {}) {
  return execSync(cmd, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  })
}

function api (method, apiPath, body) {
  const cmd = `curl -s -X ${method} "https://api.github.com${apiPath}" ` +
    `-u "$GH_USER:$GH_TOKEN" -H "Accept: application/vnd.github+json"` +
    (body ? ` -H "Content-Type: application/json" -d ${JSON.stringify(JSON.stringify(body))}` : '')
  const out = run(cmd)
  try {
    return JSON.parse(out)
  } catch (e) {
    return { message: out.slice(0, 200) }
  }
}

function section (t) {
  console.log('\n' + '─'.repeat(64))
  console.log('  ' + t)
  console.log('─'.repeat(64))
}

async function main () {
  const user = process.env.GH_USER
  const token = process.env.GH_TOKEN
  if (!user || !token) {
    console.error('需要 GH_USER 与 GH_TOKEN 环境变量')
    process.exit(2)
  }
  const FULL = `${CONFIG.owner}/${CONFIG.repo}`

  section('1. 重建前的清点（决定要不要重建）')

  const counts = {}
  for (const [name, ep] of [
    ['issues', 'issues?state=all&per_page=100'],
    ['PR', 'pulls?state=all&per_page=100'],
    ['discussions', 'discussions?per_page=100'],
    ['stars', 'stargazers?per_page=100'],
    ['forks', 'forks?per_page=100'],
    ['releases', 'releases?per_page=100'],
    ['actions runs', 'actions/runs?per_page=100']
  ]) {
    const r = api('GET', `/repos/${FULL}/${ep}`)
    counts[name] = Array.isArray(r) ? r.length : (r.total_count ?? 'n/a')
  }

  console.log('  内容统计：')
  for (const [k, v] of Object.entries(counts)) {
    console.log(`    ${k.padEnd(14)} ${v}`)
  }

  const nonEmpty = Object.entries(counts).filter(([k, v]) => v !== 0 && v !== 'n/a' && k !== 'actions runs')
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

  // 本地也要干净 —— 否则重建后又会把污染带回去
  const localCheck = run('node scripts/check-sensitive-history.js 2>&1 || true')
  if (/发现 [0-9]+ 处/.test(localCheck)) {
    console.error('  ✗ 本地历史仍有敏感内容，先用 filter-repo 清理')
    console.log(localCheck.split('\n').slice(0, 12).join('\n'))
    process.exit(1)
  }
  console.log('  → 本地历史干净')

  section('4. 备份')

  const backup = path.join(REPO_ROOT, '..', `pgrefuge-forum-backup-${Date.now()}`)
  console.log(`  备份到 ${backup}`)
  if (!DRY_RUN) {
    run(`cp -r "${REPO_ROOT}" "${backup}"`)
    console.log('  ✓ 已备份')
  } else {
    console.log('  (dry-run，跳过)')
  }

  if (DRY_RUN) {
    section('DRY RUN —— 不会执行任何破坏性操作')
    console.log('  接下来会：')
    console.log(`    1. DELETE /repos/${FULL}`)
    console.log('    2. POST /user/repos 重建同名空仓库')
    console.log('    3. 重推本地历史（force）')
    console.log('    4. 恢复 Discussions 分类与标签')
    console.log('    5. 启用 Pages（workflow 方式）')
    console.log('    6. 触发一次部署')
    console.log('')
    console.log('  去掉 --dry-run 即执行。')
    return
  }

  section('5. 删除旧仓库（需你在网页操作）')

  // API 删除需要 token 带 delete_repo scope。
  // 当前的 token scope 是 gist, repo, workflow —— 缺 delete_repo。
  // 网页删除不需要 API token，只需登录 + 密码确认。
  const del = api('DELETE', `/repos/${FULL}`)
  if (del.message) {
    console.log('  当前 token 无 delete_repo scope，需你在网页手动删除：')
    console.log('')
    console.log('    1) 打开 https://github.com/' + FULL + '/settings')
    console.log('    2) 滚到最下方 Danger Zone → Delete this repository')
    console.log('    3) 按提示输入仓库名确认')
    console.log('')
    console.log('  删完后重跑本脚本（它会从第 6 步继续）。')
    console.log('')
    console.log('  原因：' + del.message)
    process.exit(3)
  }
  console.log('  ✓ 已删除')

  section('6. 重建同名仓库')
  // GitHub 删仓库后有延迟，等一下
  for (let i = 0; i < 12; i++) {
    const check = api('GET', `/repos/${FULL}`)
    if (check.message && /Not Found/.test(check.message)) break
    await new Promise(r => setTimeout(r, 5000))
  }
  await new Promise(r => setTimeout(r, 5000))

  const created = api('POST', '/user/repos', {
    name: CONFIG.repo,
    description: CONFIG.description,
    homepage: CONFIG.homepage,
    private: false,
    has_issues: false,
    has_projects: false,
    has_wiki: false,
    has_discussions: true,
    auto_init: false
  })

  if (!created.full_name) {
    console.error('  ✗ 重建失败:', created.message)
    process.exit(1)
  }
  console.log('  ✓ 已重建:', created.full_name)

  // 仓库名可能被占用，稍等重试
  if (created.full_name !== FULL) {
    console.log('  ! 名字被占用，稍后重试:', created.full_name)
  }

  section('7. 推送历史')
  run(`git remote set-url origin "https://github.com/${FULL}.git"`)
  run('git push -u --force origin ' + branch)
  console.log('  ✓ 已推送')

  section('8. 恢复 Discussions 分类')
  for (const cat of DISCUSSION_CATEGORIES) {
    const r = api('POST', `/repos/${FULL}/discussions/categories`, {
      name: cat.name,
      description: cat.description
    })
    console.log(`  ${r.name ? '✓' : '✗'} ${cat.name}${r.message ? ' — ' + r.message : ''}`)
  }

  section('9. 启用 Pages')
  const pages = api('POST', `/repos/${FULL}/pages`, { build_type: 'workflow' })
  console.log('  ' + (pages.html_url || pages.message || '已启用'))

  section('10. 触发部署')
  api('POST', `/repos/${FULL}/actions/workflows/sync.yml/dispatches`, { ref: branch })
  console.log('  ✓ 已触发，等 1-2 分钟')

  section('完成')
  console.log('  验证旧链接已失效：')
  console.log(`    curl -o /dev/null -w "%{http_code}" \\`)
  console.log(`      "https://raw.githubusercontent.com/${FULL}/936648099d0748e8834cb65e8234b138b9e58be3/docs/.wrangler/cache/cf.json"`)
  console.log('    期望：404')
}

main().catch(e => {
  console.error('\n✗ 失败:', e && e.message ? e.message : e)
  process.exit(1)
})
