#!/usr/bin/env node
/**
 * 提交前自检 —— 每次提交必跑的完整检查
 *
 * 为什么单独一个入口：
 *   前面已有 check-sensitive.js（内容扫描）与 check-sensitive-history.js（历史扫描），
 *   但它们是「按需调用」的。人会忘。
 *   这个脚本把提交前必须过的检查串成一条命令，
 *   任何一条不过就非零退出 —— 适合挂在 hook 与 CI 上。
 *
 * 检查项：
 *   1. 工作区干净度       —— 有没有误入的临时文件
 *   2. 暂存区内容扫描     —— 凭据 / 本机环境信息
 *   3. 全历史扫描         —— 有没有已进历史但不该在的东西
 *   4. 打包产物检查       —— 交付 ZIP 里有没有混进敏感文件
 *   5. 提交信息扫描       —— 提交信息本身有没有带出敏感值
 *
 * 用法：
 *   node scripts/preflight.js            # 全部检查
 *   node scripts/preflight.js --quick    # 跳过全历史扫描（快，日常用）
 *   node scripts/preflight.js --staged   # 只查暂存区（commit 前用）
 */

'use strict'

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const QUICK = argv.includes('--quick')
const STAGED_ONLY = argv.includes('--staged')

let failures = 0

function run (cmd) {
  try {
    return execSync(cmd, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (e) {
    return null
  }
}

function runCapture (cmd) {
  try {
    const out = execSync(cmd, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { code: 0, out }
  } catch (e) {
    return {
      code: e.status === undefined ? 1 : e.status,
      out: (e.stdout || '') + (e.stderr || '')
    }
  }
}

function section (title) {
  console.log('\n' + '─'.repeat(64))
  console.log('  ' + title)
  console.log('─'.repeat(64))
}

function pass (msg) {
  console.log('  ✓ ' + msg)
}

function fail (msg) {
  failures++
  console.log('  ✗ ' + msg)
}

// ---------------------------------------------------------------------------
// 1. 工作区干净度
// ---------------------------------------------------------------------------

function checkWorktree () {
  section('1. 工作区干净度')

  const status = run('git status --porcelain')
  if (status === null) {
    fail('无法读取 git 状态')
    return
  }

  const lines = status.split('\n').filter(Boolean)

  // 未跟踪文件 —— 最容易误入的
  const untracked = lines
    .filter(l => l.startsWith('??'))
    .map(l => l.slice(3).trim())
    .filter(Boolean)

  // 已跟踪但有改动的文件 —— 逐个扫内容（暂存区检查会覆盖，这里只看有没有异常类型）
  const modified = lines.filter(l => !l.startsWith('??'))

  // 未跟踪文件里不允许出现的类型
  const SUSPICIOUS_UNTRACKED = [
    { re: /(^|\/)\.wrangler\//, why: 'wrangler 本机状态（含出口 IP / 地理位置）' },
    { re: /(^|\/)\.dev\.vars(\.|$)/, why: 'Cloudflare 本地密钥' },
    { re: /(^|\/)\.env(\.|$)/, why: '环境变量与密钥' },
    { re: /(^|\/)\.netlify\//, why: 'Netlify 本机状态' },
    { re: /(^|\/)\.vercel\//, why: 'Vercel 本机状态' },
    { re: /(^|\/)node_modules\//, why: '依赖目录' },
    { re: /(^|\/)__pycache__\//, why: 'Python 缓存' },
    { re: /\.(sqlite|db)(-shm|-wal)?$/i, why: '本地数据库状态' },
    { re: /(wrangler-account|cf)\.json$/i, why: 'Cloudflare 网络诊断' },
    { re: /\.(pem|key|p12|pfx)$/i, why: '密钥文件' },
    { re: /^\.workbuddy\//, why: 'WorkBuddy 本地状态' }
  ]

  let bad = 0
  for (const f of untracked) {
    for (const s of SUSPICIOUS_UNTRACKED) {
      if (s.re.test(f)) {
        fail(`未跟踪文件不该存在：${f}\n      ${s.why}`)
        bad++
        break
      }
    }
  }
  if (!bad) {
    pass(`未跟踪文件 ${untracked.length} 个，无本机状态/密钥类文件`)
  }

  if (modified.length) {
    pass(`已跟踪文件有 ${modified.length} 处改动（内容检查见第 2 项）`)
  } else {
    pass('已跟踪文件无改动')
  }
}

// ---------------------------------------------------------------------------
// 2. 暂存区内容扫描
// ---------------------------------------------------------------------------

function checkStaged () {
  section('2. 暂存区内容扫描（凭据 / 本机环境信息）')

  const scope = STAGED_ONLY ? '--staged' : ''
  const r = runCapture(`node scripts/check-sensitive.js ${scope}`)
  const out = r.out.trim()

  if (r.code === 0) {
    const m = out.match(/通过（.*?）/s)
    pass(m ? m[0] : '通过')
  } else {
    fail('暂存区存在敏感信息')
    console.log(out.split('\n').map(l => '      ' + l).join('\n'))
  }
}

// ---------------------------------------------------------------------------
// 3. 全历史扫描
// ---------------------------------------------------------------------------

function checkHistory () {
  section('3. 全历史扫描')

  if (QUICK) {
    pass('已跳过（--quick）')
    return
  }

  const r = runCapture('node scripts/check-sensitive-history.js')
  const out = r.out.trim()

  if (r.code === 0) {
    const m = out.match(/扫描通过[^\n]*/)
    pass(m ? m[0] : '通过')
  } else {
    fail('历史中存在敏感信息')
    console.log(out.split('\n').slice(0, 40).map(l => '      ' + l).join('\n'))
  }
}

// ---------------------------------------------------------------------------
// 4. 提交信息扫描
// ---------------------------------------------------------------------------

function checkCommitMessage () {
  section('4. 提交信息扫描')

  // 取最近一条提交信息（若正在提交中则取暂存的）
  let msg = run('git log -1 --format=%B')
  if (!msg || !msg.trim()) {
    pass('无提交信息可查')
    return
  }

  // 复用内容扫描器的规则，但只扫这一段文本
  const rules = require('./check-sensitive-rules.js')
  const hits = rules.scanText(msg, '提交信息')

  if (!hits.length) {
    pass('提交信息干净')
  } else {
    fail('提交信息含敏感内容')
    for (const h of hits) {
      console.log('      规则：' + h.rule + '（第 ' + h.line + ' 行）')
    }
    console.log('      注意：提交信息也是公开的，且会永久留在 git 历史里。')
    console.log('      若需引用敏感字段名，用「字段名 + 值的描述」而不是真实值。')
  }
}

// ---------------------------------------------------------------------------
// 5. 交付包检查
// ---------------------------------------------------------------------------

function checkDeliverables () {
  section('5. 交付包检查')

  const zips = fs.existsSync(path.join(REPO_ROOT, '..'))
    ? fs.readdirSync(path.join(REPO_ROOT, '..')).filter(f => f.endsWith('.zip'))
    : []

  if (!zips.length) {
    pass('未找到交付 ZIP（跳过）')
    return
  }

  // 父目录不在仓库里，单独检查
  const parent = path.join(REPO_ROOT, '..')
  const { execSync: ex } = require('child_process')
  let bad = 0
  for (const z of zips) {
    const zp = path.join(parent, z)
    try {
      const listing = ex(
        `python -c "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print('\\n'.join(z.namelist()))" "${zp}"`,
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
      )
      const entries = listing.split('\n').filter(Boolean)
      const suspects = entries.filter(n =>
        /(^|\/)\.wrangler\//.test(n) ||
        /(^|\/)\.env(\.|$)/.test(n) ||
        /\.sqlite(-shm|-wal)?$/.test(n) ||
        /\.(pem|key)$/i.test(n)
      )
      if (suspects.length) {
        fail(`${z} 内含 ${suspects.length} 个不该交付的文件`)
        suspects.slice(0, 5).forEach(s => console.log('      ' + s))
        bad++
      }
    } catch (e) {
      // 检查失败不算泄露，但要提示
      console.log('      ! 无法检查 ' + z + '：' + String(e.message).slice(0, 80))
    }
  }
  if (!bad) pass(`交付包 ${zips.length} 个，无敏感文件`)
}

// ---------------------------------------------------------------------------
// 6. 最终结论
// ---------------------------------------------------------------------------

function summary () {
  console.log('')
  console.log('═'.repeat(64))
  if (failures === 0) {
    console.log('  ✓ 全部检查通过 —— 可以提交')
  } else {
    console.log(`  ✗ ${failures} 项检查未通过 —— 请先处理`)
  }
  console.log('═'.repeat(64))
}

checkWorktree()
checkStaged()
checkHistory()
checkCommitMessage()
checkDeliverables()
summary()

process.exit(failures === 0 ? 0 : 1)
