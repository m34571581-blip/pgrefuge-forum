#!/usr/bin/env node
/**
 * PGrefuge 论坛 · 一键推送到 GitHub
 *
 * 用法（二选一）：
 *   A. 双击同目录的 push-to-github.cmd
 *   B. 在终端里跑：node push-to-github.js
 *
 * 做的事：
 *   1. 检查 git 环境与身份
 *   2. 询问 GitHub 用户名，自动改写 site/config.js 里的仓库占位符
 *   3. git init / add / commit
 *   4. 绑定远端仓库（可自动用 GitHub API 建仓库，需 Token）
 *   5. push，并提示后续要开的三个开关
 */
const { execFileSync, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const readline = require('readline')

const ROOT = __dirname
const CONFIG = path.join(ROOT, 'site', 'config.js')

function say(s = '') { console.log(s) }
function hr(title) {
  say('')
  say('='.repeat(58))
  say('  ' + title)
  say('='.repeat(58))
}
function step(n, t) { say(''); say(`[${n}] ${t}`) }

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: opts.quiet ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    ...opts
  })
}

function gitTry(args) {
  try {
    return { ok: true, out: git(args, { quiet: true }) }
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') }
  }
}

function ask(question, fallback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    const hint = fallback ? ` [${fallback}]` : ''
    rl.question(question + hint, (a) => {
      rl.close()
      const v = (a || '').trim() || fallback || ''
      resolve(v)
    })
  })
}

async function main() {
  say('')
  say('  PGrefuge 匿名论坛 · 推送到 GitHub')
  say('')

  // ---------- 1. 环境检查 ----------
  hr('1 / 5  环境检查')

  try {
    const v = git(['--version'], { quiet: true }).trim()
    say('  git 版本      : ' + v)
  } catch (e) {
    say('  [错误] 没找到 git。请先安装：https://git-scm.com/download/win')
    process.exit(1)
  }

  const name = gitTry(['config', '--global', 'user.name'])
  const mail = gitTry(['config', '--global', 'user.email'])
  if (!name.ok || !name.out.trim()) {
    say('  [警告] 没配置 git 身份，commit 会失败。下面会让你填。')
    const n = await ask('  你的 GitHub 用户名 : ')
    const e = await ask('  你的邮箱           : ')
    if (n) git(['config', 'user.name', n])
    if (e) git(['config', 'user.email', e])
    say('  已为本仓库设置身份。')
  } else {
    say('  git 身份      : ' + name.out.trim() + ' <' + mail.out.trim() + '>')
  }

  // ---------- 2. GitHub 用户名 ----------
  hr('2 / 5  确认 GitHub 用户名')

  let username = ''
  if (fs.existsSync(CONFIG)) {
    // 只匹配真正的配置行，不能去碰注释里的示例
    const m = fs.readFileSync(CONFIG, 'utf8').match(/^\s*repo\s*:\s*['"]([^'"]+)['"]/m)
    if (m && m[1] && !/your-username|your[-_]?name|你的用户名/i.test(m[1])) {
      username = m[1].split('/')[0]
      say('  config.js 里已有用户名 : ' + username)
    }
  }
  if (!username) {
    say('  这个用户名会决定仓库地址，也是别人访问你作品集的地址。')
    const u = await ask('  你的 GitHub 用户名（不是昵称，是 github.com/后面那串）: ')
    if (!u) {
      say('  [中止] 没有用户名无法继续。')
      process.exit(1)
    }
    username = u
  }
  say('  使用用户名 : ' + username)

  const repoName = 'pgrefuge-forum'
  const repoFull = `${username}/${repoName}`

  // ---------- 3. 改写 config.js ----------
  hr('3 / 5  更新 site/config.js')

  if (fs.existsSync(CONFIG)) {
    const before = fs.readFileSync(CONFIG, 'utf8')
    let after = before.replace(
      /^\s*repo\s*:\s*['"][^'"]+['"]/m,
      `  repo: '${repoFull}'`
    )
    // 注释里的示例也要一起换掉，免得误导后来看代码的人
    after = after.replace(
      /repo:\s*'(?:your-username|你的用户名)[^']*'/g,
      `repo: '${repoFull}'`
    )
    if (before !== after) {
      fs.writeFileSync(CONFIG, after, 'utf8')
      say('  已写入 repo = ' + repoFull)
    } else {
      say('  已经是 ' + repoFull + '，无需修改')
    }
  } else {
    say('  [警告] 找不到 site/config.js，跳过')
  }

  // ---------- 4. 本地提交 ----------
  hr('4 / 5  本地初始化与提交')

  if (fs.existsSync(path.join(ROOT, '.git'))) {
    say('  已经是 git 仓库，跳过 init')
  } else {
    git(['init', '-b', 'main'])
    say('  git init 完成（分支 main）')
  }

  // .gitignore：排除临时文件与缓存
  const gi = path.join(ROOT, '.gitignore')
  if (!fs.existsSync(gi)) {
    fs.writeFileSync(gi, [
      'node_modules/',
      '.DS_Store',
      '*.log',
      '_shot-*.png',
      'data/.raw-cache.json',
      ''
    ].join('\n'), 'utf8')
    say('  已创建 .gitignore')
  }

  git(['add', '.'])
  const status = gitTry(['status', '--porcelain'])
  const changed = status.out.split('\n').filter(Boolean).length
  say('  待提交文件数 : ' + changed)

  const already = gitTry(['log', '--oneline', '-1'])
  if (already.ok && already.out.trim()) {
    say('  已有提交     : ' + already.out.trim().split('\n')[0])
    const more = gitTry(['status', '--porcelain'])
    if (more.out.split('\n').filter(Boolean).length > 0) {
      git(['add', '.'])
      git(['commit', '-m', 'feat: 更新论坛内容与配置'])
      say('  已追加一次提交')
    }
  } else {
    git(['commit', '-m', 'feat: PGrefuge 匿名论坛初始版本'])
    say('  首次提交完成')
  }

  // ---------- 5. 远端与推送 ----------
  hr('5 / 5  绑定远端并推送')

  const remote = gitTry(['remote', 'get-url', 'origin'])
  const httpsUrl = `https://github.com/${repoFull}.git`

  let target = ''
  if (remote.ok && remote.out.trim() && !/your-username|你的用户名/.test(remote.out)) {
    target = remote.out.trim()
    say('  已有远端 origin : ' + target)
  }

  if (!target) {
    const r = await ask('  远端仓库地址（直接回车用默认 ' + httpsUrl + '）: ', httpsUrl)
    target = (r || httpsUrl).trim()
    if (!/^https?:\/\//.test(target)) {
      target = 'https://' + target.replace(/^\/+|\/+$/g, '') + '.git'
    }
    // 移除旧的 origin（可能不存在，忽略错误）
    try { git(['remote', 'remove', 'origin'], { quiet: true }) } catch (e) { /* 没有就算了 */ }
    git(['remote', 'add', 'origin', target])
    say('  已添加 origin : ' + target)
  }

  say('')
  say('  接下来会弹出浏览器让你登录 GitHub（凭据管理器 GCM），')
  say('  登录后授权一次即可。如果 10 秒内没反应，手动打开浏览器')
  say('  访问 github.com 登录，再回来重跑本脚本。')
  say('')

  let pushed = false
  let lastErr = ''
  for (let attempt = 1; attempt <= 2 && !pushed; attempt++) {
    try {
      say(`  正在推送（第 ${attempt} 次）...`)
      const out = git(['push', '-u', 'origin', 'main'], { timeout: 300000 })
      say(out.trim().split('\n').slice(-4).map(l => '    ' + l).join('\n'))
      pushed = true
    } catch (e) {
      const err = ((e.stdout || '') + (e.stderr || '')).trim()
      lastErr = err
      say('  推送失败：')
      say(err.split('\n').slice(-6).map(l => '    ' + l).join('\n'))
      if (attempt === 1) {
        const again = await ask('  再试一次？(y/n) ', 'y')
        if (again.toLowerCase() !== 'y') break
      }
    }
  }

  if (!pushed) {
    hr('推送未完成')
    const errText = lastErr || ''
    if (/does not appear to be a git repository|repository not found/i.test(errText)) {
      say('  原因：GitHub 上还没有这个仓库。')
      say('')
      say('  请先做这一步（1 分钟）：')
      say('    1. 打开 https://github.com/new')
      say('    2. Repository name 填 : ' + repoName)
      say('    3. 选 Public（公开，才能用 Pages 免费托管）')
      say('    4. 不要勾 "Add a README"（我们本地已经有了）')
      say('    5) 点 Create repository')
      say('')
      say('  完成后回到这里，再跑一次本脚本。')
    } else if (/Authentication failed|could not read Username|terminal prompts disabled/i.test(errText)) {
      say('  原因：GitHub 登录没完成。')
      say('')
      say('  请先手动打开 https://github.com 登录一次，')
      say('  然后再跑本脚本，弹出授权窗口时点 Authorize。')
    } else {
      say('  原因不明。完整错误：')
      say(errText.split('\n').slice(-10).map(l => '    ' + l).join('\n'))
    }
    say('')
    say('  代码已在本地仓库，不会丢。修好后在这个目录执行：')
    say('      git push -u origin main')
    say('')
    return
  }

  // ---------- 完成 ----------
  hr('完成')
  say('  仓库地址 : https://github.com/' + repoFull)
  say('  站点地址 : https://' + username + '.github.io/' + repoName + '/')
  say('')
  say('  还剩 3 件事要去 GitHub 网页上点（我没法替你点）：')
  say('')
  say('  1) 开 Discussions')
  say('     仓库页 -> 右上角 Settings -> General -> 勾 Discussions -> Save')
  say('')
  say('  2) 建一个叫「经历」的分类')
  say('     仓库页 -> Discussions -> 新建分类，名字必须正好是「经历」')
  say('')
  say('  3) 开 Pages 并跑一次同步')
  say('     Settings -> Pages -> Source 选 GitHub Actions')
  say('     Actions -> PGrefuge Sync -> Run workflow')
  say('')
  say('  做完第 3 步，站点就会自动更新。')
  say('  发给别人时记得带上 / 结尾，或直接发仓库地址。')
  say('')
}

main().catch((e) => {
  console.error('\n发生错误：', e.message)
  process.exit(1)
})
