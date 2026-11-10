#!/usr/bin/env node
/**
 * 站点产物反逆向加固（BLA / Blind LLM Agents）
 * ===================================================================
 *
 * 做什么：
 *   把 site/ 复制成 dist/，对其中可被 AI 自动化逆向的 JS / HTML 产物
 *   逐个注入 BLA 护盾，再做「语法 + 全局符号冲突 + 运行等价」三道校验。
 *   GitHub Pages 部署 dist/，仓库里的 site/ 保持干净可读。
 *
 * 为什么必须一个文件一个 seed（血泪教训，2026-11-10 实测）：
 *   BLA 会往每个产物里注入形如 `const _interlockSafetyCorpus_1887` 的
 *   顶层声明，后缀由 seed 决定。如果 4 个 <script> 用同一个 seed，
 *   浏览器里它们共享同一个全局词法环境，第二个脚本就会抛
 *   `Identifier has already been declared`，导致后面 3 个模块全部失效
 *   （站点看起来能开，但一键绑定/脱敏全废）。
 *   所以这里按「命名空间 + 相对路径」派生 seed，并在校验阶段做
 *   顶层符号交叉检测，任何重叠直接失败，绝不带着隐患上线。
 *
 * 防护边界（必须如实理解）：
 *   BLA 打击的是「AI 自动化逆向代理 / 批量扒站」，不是人肉读代码。
 *   本仓库是公开的，site/ 与 scripts/ 源码任何人都能直接看。
 *   想真正藏住源码，只能把仓库转私有 —— 那与「开源论坛」冲突。
 *   详见 docs/bla-hardening.md。
 *
 * 用法：
 *   node scripts/harden-site.js                 # 加固 + 全量校验，输出到 dist/
 *   node scripts/harden-site.js --dry-run       # 只打印计划，不写任何文件
 *   node scripts/harden-site.js --verify-only   # 只校验已有的 dist/，不重新加固
 *   BLA_CLI=/abs/path/to/cli.js node scripts/harden-site.js   # 指定已装好的 BLA
 *
 * 无项目级 npm 依赖：BLA 按需自动装到系统临时目录并缓存复用。
 * Node 建议 >= 24（CI 用 24）；本机 22.22.2 实测可跑，只有 EBADENGINE 警告。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const SRC = path.join(REPO_ROOT, 'site')
const OUT = path.join(REPO_ROOT, 'dist')

const BLA_VERSION = process.env.BLA_VERSION || '3.2.1'
// 改这个值会让所有产物的注入符号整体换一批（相当于重新洗牌）
const SEED_NS = process.env.BLA_SEED_NS || 'pgrefuge-v1'
const INTENSITY = process.env.BLA_INTENSITY || 'balanced'

// 需要加固的产物（相对 site/）。顺序与 index.html 里 <script> 一致。
const TARGETS = [
  'config.js',
  'desensitize.js',
  'github-client.js',
  'github-bind.js',
  'index.html'
]

// BLA 的 lane-independence lint 会把脱敏引擎的「逐字符扫描」误判成
// 授权校验里的独立分道比对。这不是安全缺陷，属于误报，故对此文件放行。
const LANE_OVERRIDE = new Set(['desensitize.js'])

const argv = process.argv.slice(2)
const DRY_RUN = argv.includes('--dry-run')
const VERIFY_ONLY = argv.includes('--verify-only')

function log (...a) { console.log(...a) }
function fail (msg) { console.error('\n✗ ' + msg); process.exit(1) }
function section (t) { log('\n=== ' + t + ' ===') }

function bytes (n) { return (n / 1024).toFixed(1) + ' KiB' }

/** 每个产物一个稳定且互不相同的 seed */
function seedFor (rel) {
  return SEED_NS + '-' + rel.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** 定位 BLA CLI：环境变量 > 项目 node_modules > 临时目录缓存（自动安装） */
function resolveBlaCli () {
  if (process.env.BLA_CLI) {
    const p = path.resolve(process.env.BLA_CLI)
    if (!fs.existsSync(p)) fail('BLA_CLI 指向的文件不存在：' + p)
    return { cmd: process.execPath, baseArgs: [p], from: 'BLA_CLI' }
  }

  const local = path.join(REPO_ROOT, 'node_modules', 'bla-agents', 'dist', 'cli.js')
  if (fs.existsSync(local)) {
    return { cmd: process.execPath, baseArgs: [local], from: '项目 node_modules' }
  }

  const cacheDir = path.join(os.tmpdir(), 'pgrefuge-bla-' + BLA_VERSION)
  const cli = path.join(cacheDir, 'node_modules', 'bla-agents', 'dist', 'cli.js')
  if (fs.existsSync(cli)) {
    return { cmd: process.execPath, baseArgs: [cli], from: '临时缓存 ' + cacheDir }
  }

  log('  首次使用，安装 bla-agents@' + BLA_VERSION + ' 到 ' + cacheDir)
  fs.mkdirSync(cacheDir, { recursive: true })
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const pkgArgs = ['install', '--prefix', cacheDir, 'bla-agents@' + BLA_VERSION,
    '--no-save', '--no-audit', '--no-fund', '--ignore-scripts']

  let last = null
  for (let i = 1; i <= 3; i++) {
    last = spawnSync(npm, pkgArgs, { stdio: 'inherit', shell: process.platform === 'win32' })
    if (last.status === 0 && fs.existsSync(cli)) break
    log('  安装失败，重试 ' + i + '/3')
  }
  if (!fs.existsSync(cli)) {
    fail('无法安装 bla-agents。可手动安装后设置 BLA_CLI 环境变量指向其 dist/cli.js')
  }
  return { cmd: process.execPath, baseArgs: [cli], from: '临时缓存 ' + cacheDir }
}

function runBla (cli, extra) {
  const r = spawnSync(cli.cmd, [...cli.baseArgs, ...extra], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const out = (r.stdout || '') + (r.stderr || '')
  if (r.status !== 0) {
    fail('BLA 执行失败（exit ' + r.status + '）：\n' + out.trim().slice(-1200))
  }
  return out
}

/** 从 BLA 输出里摘出暴露分变化，只用于日志展示 */
function extractScore (out) {
  const m = out.match(/REA Exposure Score:\s*([^\n]+)/)
  return m ? m[1].trim() : '(未解析)'
}

// ---------------------------------------------------------------------------
// 1. 复制 + 加固
// ---------------------------------------------------------------------------
function copyTree (src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name)
    const to = path.join(dst, e.name)
    if (e.isDirectory()) copyTree(from, to)
    else fs.copyFileSync(from, to)
  }
}

function harden () {
  section('1. 准备产物目录')
  // 只重建 dist/，不动 site/；dist/ 已在 .gitignore 中，永不进 git。
  fs.rmSync(OUT, { recursive: true, force: true })
  copyTree(SRC, OUT)
  log('  site/ → dist/ 已复制')

  const cli = resolveBlaCli()
  log('  BLA CLI 来源：' + cli.from)
  log('  强度：' + INTENSITY + ' | seed 命名空间：' + SEED_NS)

  section('2. 逐产物注入护盾')
  for (const rel of TARGETS) {
    const input = path.join(SRC, rel)
    const output = path.join(OUT, rel)
    if (!fs.existsSync(input)) fail('缺少源文件：' + input)

    const seed = seedFor(rel)
    const extra = ['protect', input, '-o', output,
      '--intensity', INTENSITY, '--seed', seed]
    if (LANE_OVERRIDE.has(rel)) extra.push('--allow-lane-independent')

    const out = runBla(cli, extra)
    if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
      fail('加固产物为空：' + rel)
    }
    const before = fs.statSync(input).size
    const after = fs.statSync(output).size
    log('  ✓ ' + rel.padEnd(20) + bytes(before) + ' → ' + bytes(after) +
      '  [' + extractScore(out) + ']')
  }

  const total = TARGETS.reduce((n, r) =>
    n + fs.statSync(path.join(OUT, r)).size, 0)
  log('  加固产物合计：' + bytes(total))
}

// ---------------------------------------------------------------------------
// 2. 校验
// ---------------------------------------------------------------------------

/** 取「行首」的顶层声明名 —— 用来抓跨 <script> 的重复声明 */
function topLevelDecls (code) {
  const set = new Set()
  for (const line of code.split(/\r?\n/)) {
    const m = line.match(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/)
    if (m) set.add(m[1])
  }
  return set
}

/** HTML 只取内联 <script> 块（排除带 src 的外链） */
function inlineScripts (html) {
  const blocks = []
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    if (!/\bsrc\s*=/.test(m[1]) && m[2].trim()) blocks.push(m[2])
  }
  return blocks
}

function checkSymbolCollisions () {
  section('3. 全局符号冲突检测')
  const seen = new Map()
  const conflicts = []
  for (const rel of TARGETS) {
    const code = fs.readFileSync(path.join(OUT, rel), 'utf8')
    const chunks = rel.endsWith('.html') ? inlineScripts(code) : [code]
    for (const chunk of chunks) {
      for (const name of topLevelDecls(chunk)) {
        if (seen.has(name) && seen.get(name) !== rel) {
          conflicts.push(name + '（' + seen.get(name) + ' ↔ ' + rel + '）')
        } else {
          seen.set(name, rel)
        }
      }
    }
  }
  if (conflicts.length) {
    fail('检测到跨脚本重复的顶层声明，浏览器会抛 Identifier has already been declared：\n  ' +
      [...new Set(conflicts)].slice(0, 12).join('\n  ') +
      '\n  处理：换一个 BLA_SEED_NS，或确保每个产物的 seed 互不相同。')
  }
  log('  ✓ 无重复顶层声明（共扫描 ' + seen.size + ' 个符号）')
}

function checkSyntax () {
  section('4. 语法检查')
  for (const rel of TARGETS.filter(r => r.endsWith('.js'))) {
    const r = spawnSync(process.execPath, ['--check', path.join(OUT, rel)], { encoding: 'utf8' })
    if (r.status !== 0) fail(rel + ' 语法错误：\n' + (r.stderr || '').slice(0, 500))
    log('  ✓ ' + rel)
  }
}

/**
 * 浏览器沙箱：故意不提供 require / process / Buffer / module，
 * 与真实浏览器一致；顶层 const 共享同一词法环境，能复现重复声明问题。
 */
function makeSandbox () {
  const win = {}
  const doc = {
    createElement: () => ({ style: {}, setAttribute () {}, appendChild () {} }),
    head: { appendChild () {} }, body: { appendChild () {} },
    addEventListener () {}, querySelector: () => null, querySelectorAll: () => []
  }
  const s = {
    window: win, self: win, document: doc, console,
    navigator: { userAgent: 'Mozilla/5.0' },
    location: { href: 'https://example.invalid/', origin: 'https://example.invalid' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => Promise.reject(new Error('network disabled')),
    URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa
  }
  vm.createContext(s)
  return { s, win }
}

function loadAll (dir) {
  const { s, win } = makeSandbox()
  for (const rel of ['config.js', 'desensitize.js', 'github-client.js', 'github-bind.js']) {
    const file = path.join(dir, rel)
    // 同一 context 依次执行，等价于 index.html 里 4 个 <script> 的顺序
    vm.runInContext(fs.readFileSync(file, 'utf8'), s, { timeout: 15000, filename: file })
  }
  return { s, win }
}

// 等价测试的样例：刻意只用中性文本 / 白名单占位域名，
// 不写入任何真实手机号、邮箱、IP 或身份信息（脚本本身会被 preflight 扫描）。
const SAMPLES = [
  '这是一段完全普通的文本，用于确认加固前后输出一致。',
  '我在某大学读研，导师姓王，联系方式见站内信。',
  '编号 ABC-2026-001，邮箱 user@example.edu.cn，日期 2026 年 11 月。',
  '', 'a'.repeat(300),
  '混合文本：某同学 + 某课题组 + 某学院 + 普通描述，用于覆盖多条规则分支。'
]

function checkEquivalence () {
  section('5. 运行等价校验')
  let a, b
  try { a = loadAll(SRC) } catch (e) { fail('原始站点加载失败：' + e.message) }
  try { b = loadAll(OUT) } catch (e) {
    fail('加固站点加载失败（这正是全量加固最容易踩的坑）：' + e.message)
  }

  const shape = w => JSON.stringify(w, (k, v) => typeof v === 'function' ? '[fn]' : v)
  if (shape(a.win) !== shape(b.win)) {
    fail('window 导出不一致：\n  原始 ' + Object.keys(a.win) + '\n  加固 ' + Object.keys(b.win))
  }
  log('  ✓ 全局模块导出一致：' + Object.keys(b.win).join(', '))

  const A = a.win.PGDesensitize, B = b.win.PGDesensitize
  if (!A || !B) fail('脱敏引擎未导出')
  let calls = 0
  for (const text of SAMPLES) {
    for (const opts of [undefined, { aggressive: true }, { aggressive: false }]) {
      const ra = JSON.stringify(A.desensitize(text, opts))
      const rb = JSON.stringify(B.desensitize(text, opts))
      if (ra !== rb) fail('desensitize 输出不一致，输入=' + text.slice(0, 20))
      const hits = JSON.parse(ra).hits
      if (JSON.stringify(A.summarize(hits)) !== JSON.stringify(B.summarize(hits))) {
        fail('summarize 输出不一致，输入=' + text.slice(0, 20))
      }
      calls += 2
    }
  }
  for (const key of ['HIT_LABELS', 'GENERIC', 'TITLES', 'GENERIC_ORG', 'ORGS', 'VIRTUAL']) {
    if (JSON.stringify(A[key]) !== JSON.stringify(B[key])) fail('常量表不一致：' + key)
    calls++
  }
  log('  ✓ 脱敏引擎 ' + calls + ' 组调用 / 常量逐字节一致')

  // 配置里含 OAuth Client ID，必须原样保留，否则一键绑定会失效
  if (JSON.stringify(a.win.PG_CONFIG) !== JSON.stringify(b.win.PG_CONFIG)) {
    fail('PG_CONFIG 不一致，一键绑定会失效')
  }
  log('  ✓ PG_CONFIG 完全一致（含 OAuth Client ID）')
}

function verify () {
  if (!fs.existsSync(OUT)) fail('dist/ 不存在，请先运行 node scripts/harden-site.js')
  for (const rel of TARGETS) {
    if (!fs.existsSync(path.join(OUT, rel))) fail('dist/ 缺少产物：' + rel)
  }
  checkSymbolCollisions()
  checkSyntax()
  checkEquivalence()
}

// ---------------------------------------------------------------------------
function main () {
  log('PGrefuge 站点反逆向加固 · BLA ' + BLA_VERSION)
  log('源目录：' + SRC)
  log('产物目录：' + OUT)

  if (DRY_RUN) {
    section('dry-run：只打印计划，不写任何文件')
    log('  将复制 site/ → dist/，并对以下产物逐个加固：')
    TARGETS.forEach(r => log('    - ' + r.padEnd(20) + 'seed=' + seedFor(r) +
      (LANE_OVERRIDE.has(r) ? '  [--allow-lane-independent]' : '')))
    log('  随后执行：符号冲突检测 → 语法检查 → 运行等价校验')
    log('  完成后由 sync.yml 把 dist/ 部署到 GitHub Pages')
    return
  }

  if (VERIFY_ONLY) {
    verify()
  } else {
    harden()
    verify()
  }

  section('完成')
  log('  ✓ 三道校验全部通过，dist/ 可部署')
  log('  提示：dist/ 已在 .gitignore 中，加固产物（含 BLA 蜜罐诱饵）绝不进 git。')
}

main()
