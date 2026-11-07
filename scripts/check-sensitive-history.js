#!/usr/bin/env node
/**
 * 敏感信息扫描 —— **整个 git 历史**
 *
 * 为什么必须扫历史
 * ---------------
 * 「文件删了就没事了」是错的。GitHub 上按 SHA 直取 blob 依然有效：
 *
 *   https://raw.githubusercontent.com/<owner>/<repo>/<旧SHA>/<路径>
 *
 * 只要对象还在服务器上，任何人都能直接下载 ——
 * 哪怕那个提交早就从分支历史里消失了。
 * 实测过：force push 之后旧提交页仍返回 200，raw 链接照样能下到文件。
 *
 * 只有两条路能真正清除：
 *   1. git-filter-repo 重写历史 + force push（断开所有 ref 引用）
 *   2. 触发 GitHub 服务端 GC（删分支重建、或等待后台回收）
 *
 * 所以防线必须是**在入库前**拦截，而不是事后补救。
 *
 * 用法
 * ----
 *   node scripts/check-sensitive-history.js
 *   node scripts/check-sensitive-history.js --verbose   # 列出每个命中的文件
 *
 * 退出码：0 = 干净，1 = 发现问题
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const VERBOSE = process.argv.includes('--verbose')

// ---------------------------------------------------------------------------
// 规则表（与 check-sensitive.js 保持一致，但只扫内容、不看路径）
// ---------------------------------------------------------------------------

const RULES = [
  // ---- 凭据 ----
  { kind: '凭据', name: 'GitHub PAT（fine-grained）', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: '凭据', name: 'GitHub PAT（classic）', pattern: /\bghp_[A-Za-z0-9]{30,}/g },
  { kind: '凭据', name: 'GitHub OAuth token', pattern: /\bgho_[A-Za-z0-9]{30,}/g },
  { kind: '凭据', name: 'GitHub App token', pattern: /\bghs_[A-Za-z0-9]{30,}/g },
  { kind: '凭据', name: 'GitHub refresh token', pattern: /\bghr_[A-Za-z0-9]{30,}/g },
  { kind: '凭据', name: 'WorkBuddy publishable key', pattern: /\bwbpk_[A-Za-z0-9_]{20,}/g },
  { kind: '凭据', name: 'Cloudflare API token', pattern: /\bCLOUDFLARE_API_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{30,}/g },
  { kind: '凭据', name: 'Cloudflare oauth token', pattern: /\boauth_token\s*[:=]\s*["'][A-Za-z0-9_-]{30,}/g },
  { kind: '凭据', name: 'Cloudflare refresh token', pattern: /\brefresh_token\s*[:=]\s*["'][A-Za-z0-9_-]{30,}/g },
  { kind: '凭据', name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: '凭据', name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}/g },
  { kind: '凭据', name: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{30,}/g },
  { kind: '凭据', name: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{40,}/g },
  { kind: '凭据', name: '私有钥', pattern: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { kind: '凭据', name: 'Authorization 头', pattern: /["']?Authorization["']?\s*[:=]\s*["']Bearer\s+[A-Za-z0-9._-]{20,}/gi },

  // ---- 本机环境 ----
  //
  // 注意：这些字段名本身不是敏感信息 —— 文档里写
  // 「我们检查了 tlsClientRandom 字段」是正常的说明文字。
  // 真正敏感的是**字段带着实际值**（出口 IP、城市名、ASN 名）。
  // 所以规则要求「字段名 + 冒号 + 值」同时出现，
  // 纯提及字段名不报。
  { kind: '环境', name: 'Cloudflare 边缘节点诊断', pattern: /"colo"\s*:\s*"[A-Z]{3}"/g },
  { kind: '环境', name: 'Cloudflare TLS 握手随机数', pattern: /"tlsClientRandom"\s*:\s*"[^"]{8,}"/g },
  { kind: '环境', name: 'ASN 运营商信息', pattern: /"asOrganization"\s*:\s*"[^"]{3,}"/g },
  { kind: '环境', name: 'Cloudflare 出口 IP（162.159.x.x）', pattern: /\b162\.159\.\d{1,3}\.\d{1,3}\b/g }
]

/** 路径黑名单 —— 这些路径在任何历史提交里出现都是问题 */
const BLOCKED_PATHS = [
  { pattern: /(^|\/)\.wrangler\//, reason: 'wrangler 本机状态（含出口 IP / 地理位置）' },
  { pattern: /(^|\/)\.dev\.vars(\.|$)/, reason: 'Cloudflare 本地密钥' },
  { pattern: /(^|\/)\.env(\.|$)/, reason: '环境变量与密钥' },
  { pattern: /(^|\/)wrangler-account\.json$/, reason: 'wrangler 账号信息' },
  { pattern: /(^|\/)cf\.json$/, reason: 'Cloudflare 网络诊断' }
]

const MAX_BLOB_BYTES = 2 * 1024 * 1024
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz',
  '.mp3', '.mp4', '.woff', '.woff2', '.ttf', '.eot'
])

/**
 * 扫描器自身
 *
 * 这两个文件里必然含有敏感模式的**字面量**
 * （规则写成 /"tlsClientRandom"/ 就会命中自己）。
 * 排除掉，但路径检查仍然生效。
 */
const SELF_FILES = new Set([
  'scripts/check-sensitive.js',
  'scripts/check-sensitive-history.js'
])

/**
 * 豁免标记
 *
 * 有些地方**必然**会出现敏感模式的字面量 —— 比如文档里展示
 * 「违规的写法长这样：\"tlsClientRandom\": \"...\"」，
 * 或者提交信息里解释规则的正则。
 *
 * 这些不是泄露，但逐个加豁免太啰嗦。所以约定一个标记：
 *   在包含敏感模式的行末加 `pgrefuge:allow-sensitive`，
 *   扫描器就跳过这一行。
 *
 * 豁免是**显式**的 —— 每加一个都要有人判断过。
 * 滥用豁免等于关掉检查，所以标记本身要显眼。
 */
const ALLOW_MARK = 'pgrefuge:allow-sensitive'

/** 逐行扫描，跳过带豁免标记的行 */
function countMatches (text, pattern) {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
  let n = 0
  for (const line of text.split('\n')) {
    if (line.includes(ALLOW_MARK)) continue
    const m = line.match(re)
    if (m) n += m.length
  }
  return n
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function run (cmd) {
  try {
    return execSync(cmd, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch (e) {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main () {
  // ---- 前置检查：必须能拿到完整历史 ----
  const isShallow = /true/.test(run('git rev-parse --is-shallow-repository').trim())
  if (isShallow) {
    console.error('✗ 这是浅克隆（shallow），拿不到完整历史。')
    console.error('  请用 git fetch --unshallow 后再运行。')
    return 1
  }

  const commitCount = run('git rev-list --count --all').trim()
  console.log('扫描范围：' + commitCount + ' 个提交，全历史')
  console.log('')

  // ---- 1. 路径黑名单：任何历史提交里都不该有这些路径 ----
  const pathProblems = []
  const allPaths = run(
    'git log --all --pretty=format: --name-only --diff-filter=A'
  ).split('\n')

  const seenPaths = new Set()
  for (const p of allPaths) {
    const rel = p.trim()
    if (!rel || seenPaths.has(rel)) continue
    seenPaths.add(rel)
    for (const bp of BLOCKED_PATHS) {
      if (bp.pattern.test(rel)) {
        pathProblems.push({ file: rel, reason: bp.reason })
        break
      }
    }
  }

  if (pathProblems.length) {
    console.error('✗ 历史中发现 ' + pathProblems.length + ' 个不该入库的路径')
    console.error('')
    for (const p of pathProblems) {
      console.error('  ' + p.file)
      console.error('      ' + p.reason)
    }
    console.error('')
    console.error('这些文件已被 git rm --cached 删掉，但**仍在 git 历史里**。')
    console.error('必须用 git-filter-repo 重写历史才能真正清除。')
    console.error('')
  }

  // ---- 2. 内容扫描：遍历所有历史 blob ----
  const objects = run(
    'git rev-list --objects --all | git cat-file --batch-check="%(objecttype) %(objectname) %(objectsize) %(rest)"'
  ).split('\n')

  const blobLines = []
  for (const line of objects) {
    const m = line.match(/^blob\s+([0-9a-f]{40})\s+(\d+)\s*(.*)$/)
    if (m) blobLines.push({ sha: m[1], size: Number(m[2]), path: m[3] })
  }

  console.log('扫描 blob：' + blobLines.length + ' 个')

  const contentProblems = []
  let scanned = 0
  let skipped = 0

  for (const b of blobLines) {
    // 跳过超大文件与明显的二进制
    if (b.size > MAX_BLOB_BYTES) { skipped++; continue }
    if (BINARY_EXT.has(path.extname(b.path || '').toLowerCase())) { skipped++; continue }
    // 扫描器自身跳过内容检查（规则定义里含有敏感模式的字面量）
    if (SELF_FILES.has((b.path || '').replace(/\\/g, '/'))) { skipped++; continue }

    const raw = run('git cat-file -p ' + b.sha)
    if (!raw) { skipped++; continue }
    // 含 NUL → 二进制
    if (raw.indexOf('\u0000') !== -1) { skipped++; continue }

    scanned++
    for (const r of RULES) {
      const n = countMatches(raw, r.pattern)
      if (n > 0) {
        contentProblems.push({
          file: b.path || '(无路径)',
          sha: b.sha.slice(0, 12),
          kind: r.kind,
          rule: r.name,
          count: n
        })
      }
    }
  }

  console.log('实际扫描：' + scanned + ' 个（跳过二进制/超大文件 ' + skipped + ' 个）')
  console.log('')

  // ---- 3. 提交信息扫描 ----
  //
  // 只扫**凭据**类，不扫环境字段类。
  //
  // 原因：提交信息里提到字段名或写规则示例是正常的说明文字
  //（比如「规则改成 \"tlsClientRandom\": \"...\" 这样」）。
  // 环境字段的泄露风险在**文件内容**里，不在提交信息里 ——
  // cf.json 这种诊断文件是被当作文件提交的，提交信息只是描述。
  //
  // 凭据则相反：token 出现在提交信息里就是真泄露，必须扫。
  const msgProblems = []
  const msgs = run('git log --all --format=%H%x00%s%x00%b%x1e')
  for (const chunk of msgs.split('\u001e')) {
    if (!chunk.trim()) continue
    const [sha, subject, body] = chunk.split('\u0000')
    const text = (subject || '') + '\n' + (body || '')
    for (const r of RULES) {
      if (r.kind !== '凭据') continue
      const n = countMatches(text, r.pattern)
      if (n > 0) {
        msgProblems.push({
          sha: (sha || '').slice(0, 12),
          kind: r.kind,
          rule: r.name,
          count: n
        })
      }
    }
  }

  // ---- 输出 ----
  const total = pathProblems.length + contentProblems.length + msgProblems.length

  if (!total) {
    console.log('✓ 历史扫描通过 —— 未发现凭据或本机环境信息')
    return 0
  }

  console.error('✗ 历史扫描发现 ' + total + ' 处问题')
  console.error('')

  if (contentProblems.length) {
    console.error('【文件内容】' + contentProblems.length + ' 处')
    const seen = new Set()
    for (const p of contentProblems) {
      const key = p.file + '|' + p.rule
      if (seen.has(key)) continue
      seen.add(key)
      console.error('  ' + p.file + '  (' + p.sha + ')')
      console.error('      ' + p.kind + '：' + p.rule + ' × ' + p.count)
    }
    console.error('')
  }

  if (msgProblems.length) {
    console.error('【提交信息】' + msgProblems.length + ' 处')
    for (const p of msgProblems) {
      console.error('  ' + p.sha + '  ' + p.kind + '：' + p.rule + ' × ' + p.count)
    }
    console.error('')
  }

  console.error('清除方法：')
  console.error('  # 1. 用 git-filter-repo 重写历史（同时清文件与内容）')
  console.error('  git filter-repo --invert-paths --path docs/.wrangler/ \\')
  console.error('      --replace-text <替换规则> --replace-message <替换规则>')
  console.error('')
  console.error('  # 2. force push')
  console.error('  git push --force origin main')
  console.error('')
  console.error('  # 3. 触发 GitHub 服务端 GC（删分支重建，断开所有 ref 引用）')
  console.error('  #    详见 docs/github-binding-research.md')
  console.error('')
  console.error('注意：重写后仍需等 GitHub 后台 GC 完成，')
  console.error('      否则 raw.githubusercontent.com 按旧 SHA 仍能下载到文件。')
  console.error('')
  return 1
}

process.exit(main())
