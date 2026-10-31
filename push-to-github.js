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
 *   2. 自动探测网络代理（国内直连 GitHub 通常被墙）
 *   3. 询问 GitHub 用户名，自动改写 site/config.js 里的仓库占位符
 *   4. git init / add / commit
 *   5. 绑定远端仓库并推送，提示后续要开的三个开关
 */
const { execFileSync, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const net = require('net')
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

// ---------------------------------------------------------------------------
// 代理探测
//
// 国内直连 GitHub 基本会被墙，而 git **不读 http_proxy 环境变量**
// （只有 curl / npm 这类工具读），所以 git 会「裸奔」直连然后超时失败。
// 这里主动扫描本机常见代理端口，验证它能否真的 CONNECT 到 GitHub，
// 找到就写进本次推送的 git 配置（只影响本仓库，不污染全局设置）。
// ---------------------------------------------------------------------------

const PROXY_PORTS = [
  7897, 7890, 7891, 7892, 10809, 10808, 1080, 1081, 1087, 10810,
  8888, 8080, 8118, 33210, 4780, 9090, 20171, 789
]

function portOpen(port, host = '127.0.0.1', timeout = 900) {
  return new Promise((resolve) => {
    const s = new net.Socket()
    let done = false
    const finish = (v) => { if (!done) { done = true; s.destroy(); resolve(v) } }
    s.setTimeout(timeout)
    s.once('connect', () => finish(true))
    s.once('timeout', () => finish(false))
    s.once('error', () => finish(false))
    s.connect(port, host)
  })
}

/**
 * 用 curl 验证某个端口能否作为 HTTP 代理 CONNECT 到 GitHub。
 *
 * 注意：Windows 上没有 /dev/null，curl 会因写文件失败返回退出码 23，
 * 但 stdout 里已经有正确的状态码。所以这里用 NUL（Windows），
 * 并且把 stdout 的内容作为判定依据，而不是依赖退出码。
 */
function proxyWorks(port) {
  const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null'
  try {
    const out = execFileSync('curl', [
      '-s', '-m', '12', '-o', nullDev, '-w', '%{http_code}',
      '-x', `http://127.0.0.1:${port}`,
      'https://github.com'
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 })
    const code = String(out).trim()
    return code === '200'
  } catch (e) {
    // curl 可能因退出码非 0 抛异常，但 stdout 里已有状态码
    const code = String((e.stdout || '')).trim()
    return code === '200'
  }
}

/** 直连能否访问 GitHub（不走任何代理） */
function directWorks() {
  const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null'
  try {
    const out = execFileSync('curl', [
      '-s', '-m', '12', '--noproxy', '*', '-o', nullDev, '-w', '%{http_code}',
      'https://github.com'
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 })
    return String(out).trim() === '200'
  } catch (e) {
    return String((e.stdout || '')).trim() === '200'
  }
}

async function detectProxy() {
  say('  测试直连 GitHub ...')
  if (directWorks()) {
    say('  直连正常，无需代理')
    return null
  }
  say('  直连不通（国内网络常见），扫描本地代理端口 ...')

  // 先看环境变量里给的端口，可能就是对的
  const envPorts = []
  for (const k of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy']) {
    const v = process.env[k]
    if (!v) continue
    const m = String(v).match(/:(\d+)\s*$/)
    if (m) envPorts.push(parseInt(m[1], 10))
  }

  const candidates = [...new Set([...envPorts, ...PROXY_PORTS])]
  for (const port of candidates) {
    if (!port || port < 1 || port > 65535) continue
    const open = await portOpen(port)
    if (!open) continue
    process.stdout.write(`    端口 ${port} 开放，验证中 ... `)
    if (proxyWorks(port)) {
      say('可用')
      return port
    }
    say('不是 HTTP 代理')
  }
  return null
}

/**
 * 检查 git 能否读到远端。
 *
 * Windows 版 git 默认用 schannel（系统 TLS），在国内网络下经常报
 *   schannel: server closed abruptly (missing close_notify)
 * —— 连接被中间设备粗暴切断。切到 OpenSSL 后端即可解决，
 * 而且不需要配代理。所以这里做一次探测，需要时自动切换。
 */
function remoteReadable(repoUrl) {
  const r = gitTry(['ls-remote', repoUrl, 'refs/heads/main'])
  return r.ok && r.out.trim().length > 0
}

function ensureTlsBackend(repoUrl, proxyPort) {
  // 先看当前能不能读
  if (remoteReadable(repoUrl)) return 'ok'

  say('  默认 TLS 后端读不到远端，尝试切换到 OpenSSL ...')
  try { git(['config', 'http.sslBackend', 'openssl'], { quiet: true }) } catch (e) { /* 忽略 */ }
  if (remoteReadable(repoUrl)) {
    say('  已切换 http.sslBackend=openssl，问题解决')
    return 'ok'
  }

  // 还不行，试代理
  if (!proxyPort) {
    say('  OpenSSL 仍不行，且没有可用代理')
    return 'fail'
  }
  say('  OpenSSL 仍不行，回退到「代理 + OpenSSL」...')
  const withProxy = ['-c', 'http.sslBackend=openssl']
  withProxy.push('-c', `http.proxy=http://127.0.0.1:${proxyPort}`)
  withProxy.push('-c', `https.proxy=http://127.0.0.1:${proxyPort}`)
  try {
    git(['ls-remote', ...withProxy, repoUrl, 'refs/heads/main'], { quiet: true })
    say('  通过代理可以读到远端')
    git(['config', 'http.proxy', `http://127.0.0.1:${proxyPort}`], { quiet: true })
    git(['config', 'https.proxy', `http://127.0.0.1:${proxyPort}`], { quiet: true })
    return 'proxy'
  } catch (e) {
    say('  仍然读不到远端')
    return 'fail'
  }
}

async function main() {
  say('')
  say('  PGrefuge 匿名论坛 · 推送到 GitHub')
  say('')

  // ---------- 1. 环境检查 ----------
  hr('1 / 6  环境检查')

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

  // ---------- 2. 网络连通性 ----------
  hr('2 / 6  检查网络连通性')

  // git 不读 http_proxy 环境变量，国内直连 GitHub 通常会超时失败，
  // 所以这里主动探测本机代理，找到就写进本仓库的 git 配置。
  const proxyPort = await detectProxy()
  let proxyApplied = false
  if (proxyPort) {
    const proxyUrl = `http://127.0.0.1:${proxyPort}`
    git(['config', 'http.proxy', proxyUrl])
    git(['config', 'https.proxy', proxyUrl])
    say(`  已为本仓库设置代理 : ${proxyUrl}`)
    say('  （只影响这个仓库，不改你的全局 git 配置）')
    proxyApplied = true
  } else {
    say('  没找到可用代理。若推送超时，请先开启你的代理软件再重跑。')
  }

  // ---------- 3. GitHub 用户名 ----------
  hr('3 / 6  确认 GitHub 用户名')

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
  hr('4 / 6  更新 site/config.js')

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
  hr('5 / 6  本地初始化与提交')

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
  hr('6 / 6  绑定远端并推送')

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

  // ---------- 6. 推送前的网络与历史对齐 ----------
  //
  // 两件事：
  //  a) TLS 后端：Windows git 默认用 schannel，国内网络下会被粗暴切断
  //     （schannel: server closed abruptly），切 OpenSSL 即可
  //  b) 历史对齐：远端若是 GitHub 自动生成的独立 README，
  //     push 会被 rejected，需要先合并
  say('')
  say('  检查远端可读性 ...')
  const tlsState = ensureTlsBackend(target, proxyPort)
  if (tlsState === 'fail') {
    say('  [警告] 暂时读不到远端，但仍会尝试推送（可能是临时抖动）')
  }

  say('')
  say('  检查远端历史 ...')
  const lsRemote = gitTry(['ls-remote', 'origin', 'refs/heads/main'])
  const remoteHasContent = lsRemote.ok && lsRemote.out.trim().length > 0

  if (remoteHasContent) {
    say('  远端已有内容，先对齐历史 ...')
    // 拉下远端引用
    const fetch = gitTry(['fetch', 'origin', 'main'])
    if (fetch.ok) {
      // 判断本地与远端是否同源
      const mergeBase = gitTry(['merge-base', 'main', 'origin/main'])
      const unrelated = !mergeBase.ok

      if (unrelated) {
        say('  远端是独立历史（多半是 GitHub 自动生成的 README），')
        say('  正在合并（保留远端那条提交，但用我们的 README 覆盖它）...')
        const allow = gitTry([
          'pull', 'origin', 'main', '--allow-unrelated-histories',
          '--no-edit', '-X', 'ours'
        ])
        if (allow.ok) {
          say('  合并完成')
          // 合并后 README 可能变成远端那版，用本地版本覆盖回去
          git(['checkout', 'HEAD', '--', 'README.md'])
          const st = gitTry(['status', '--porcelain'])
          if (st.out.trim()) {
            git(['add', '.'])
            git(['commit', '-m', 'docs: 用完整版 README 覆盖 GitHub 自动生成的占位文件'])
            say('  已恢复完整 README')
          }
        } else {
          say('  [警告] 自动合并失败，将改用强制推送')
        }
      } else {
        say('  历史可快进，直接推送')
      }
    }
  } else {
    say('  远端为空，直接推送')
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
    if (/Failed to connect to|Could not connect to server|Connection timed out|CONNECT tunnel failed/i.test(errText)) {
      say('  原因：连不上 GitHub（网络问题，不是代码问题）。')
      say('')
      if (proxyApplied) {
        say('  已自动配置代理 ' + 'http://127.0.0.1:' + proxyPort + '，但仍失败。')
        say('  可能是代理软件没运行，或端口变了。')
      } else {
        say('  没探测到可用代理。')
      }
      say('')
      say('  怎么办：')
      say('    1. 打开你的代理软件（Clash / v2ray / 各类加速器）')
      say('    2. 确认它已连接、系统代理已开启')
      say('    3. 回到这里重跑本脚本 —— 它会重新扫描代理端口')
      say('')
      say('  如果你用的是系统代理而非本地端口，可以在 PowerShell 里先设：')
      say('    $env:HTTPS_PROXY = "http://127.0.0.1:7897"')
      say('    node push-to-github.js')
    } else if (/rejected|non-fast-forward|fetch first|Updates were rejected/i.test(errText)) {
      say('  原因：远端已经有提交，且和本地不是同一条历史。')
      say('')
      say('  这通常是因为你在 GitHub 网页端建仓库时勾了 README。')
      say('  两种解法：')
      say('')
      say('    A. 保留远端内容，拉取后再合并（推荐，不丢任何东西）：')
      say('       git pull origin main --allow-unrelated-histories')
      say('       git push -u origin main')
      say('')
      say('    B. 强制覆盖远端（会丢掉远端已有内容，谨慎）：')
      say('       git push -u origin main --force')
    } else if (/does not appear to be a git repository|repository not found/i.test(errText)) {
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
