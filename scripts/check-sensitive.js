#!/usr/bin/env node
/**
 * 敏感信息扫描 —— 提交前的最后一道关卡
 *
 * 为什么需要它
 * ------------
 * 这个仓库会跑 wrangler dev、Playwright、Python 脚本，
 * 各种工具都可能在工作目录里留下「本机状态」文件：
 *   - .wrangler/  → Cloudflare 边缘节点诊断（出口 IP、地理位置、TLS 握手随机数）
 *   - .cache/     → 各种框架的本地状态
 *   - .env        → 各种密钥
 *
 * 这些文件一旦进了 git 历史，即使后来删掉，
 * 别人 `git log -p` 就能翻出来 —— 而且 GitHub 上按 SHA 直取 blob 依然有效。
 * 所以必须在**入库前**拦住，而不是事后补救。
 *
 * 用法
 * ----
 *   node scripts/check-sensitive.js                # 扫工作区已跟踪文件
 *   node scripts/check-sensitive.js --staged       # 只扫暂存区（pre-commit 用）
 *   node scripts/check-sensitive.js --dir <路径>   # 扫指定目录
 *
 * 退出码：0 = 干净，1 = 发现问题
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const REPO_ROOT = path.resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------

/**
 * 凭据类 —— 命中即阻断
 *
 * 注意 `github_pat_` / `ghp_` 这类前缀是 GitHub 官方格式；
 * `wbpk_` 是 WorkBuddy 云服务的 publishable key。
 */
const CREDENTIAL_RULES = [
  { name: 'GitHub PAT（fine-grained）', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'GitHub PAT（classic）', pattern: /\bghp_[A-Za-z0-9]{30,}/g },
  { name: 'GitHub OAuth token', pattern: /\bgho_[A-Za-z0-9]{30,}/g },
  { name: 'GitHub App token', pattern: /\bghs_[A-Za-z0-9]{30,}/g },
  { name: 'GitHub refresh token', pattern: /\bghr_[A-Za-z0-9]{30,}/g },
  { name: 'WorkBuddy publishable key', pattern: /\bwbpk_[A-Za-z0-9_]{20,}/g },
  { name: 'Cloudflare API token', pattern: /\bCLOUDFLARE_API_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{30,}/g },
  { name: 'Cloudflare oauth token', pattern: /\boauth_token\s*[:=]\s*["'][A-Za-z0-9_-]{30,}/g },
  { name: 'Cloudflare refresh token', pattern: /\brefresh_token\s*[:=]\s*["'][A-Za-z0-9_-]{30,}/g },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}/g },
  { name: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{30,}/g },
  { name: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{40,}/g },
  { name: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9]{40,}/g },
  { name: '私有钥', pattern: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'Authorization 头', pattern: /["']?Authorization["']?\s*[:=]\s*["']Bearer\s+[A-Za-z0-9._-]{20,}/gi },
  { name: '通用 api_key 赋值', pattern: /\bapi[_-]?key\s*[:=]\s*["'][A-Za-z0-9_-]{24,}/gi },
  { name: '通用 secret 赋值', pattern: /\b(secret|password|passwd|token)\s*[:=]\s*["'][^"'\s]{16,}["']/gi }
]

/**
 * 本机环境泄露类 —— 命中即阻断
 *
 * 这些不是「凭据」，但同样属于不该进公开仓库的东西：
 * 出口 IP（能被用于定位）、地理位置、运营商信息。
 *
 * 注意：字段名本身不敏感 —— 写「我们检查了 tlsClientRandom 字段」
 * 是正常的说明文字。真正敏感的是**字段带着实际值**。
 * 所以规则要求「字段名 + 冒号 + 值」同时出现，纯提及不报。
 */
const EXPOSURE_RULES = [
  { name: 'Cloudflare 边缘节点诊断文件', pattern: /"colo"\s*:\s*"[A-Z]{3}"/g, hint: 'wrangler 留下的出口节点信息' },
  { name: 'Cloudflare TLS 握手随机数', pattern: /"tlsClientRandom"\s*:\s*"[^"]{8,}"/g, hint: '网络会话指纹' },
  { name: 'ASN 运营商信息', pattern: /"asOrganization"\s*:\s*"[^"]{3,}"/g, hint: '暴露网络服务商' },
  { name: 'IP 地理位置字段', pattern: /"(city|region|country|latitude|longitude)"\s*:\s*"[^"]+"/g, hint: '地理位置' },
  { name: 'Cloudflare 出口 IP（162.159.x.x）', pattern: /\b162\.159\.\d{1,3}\.\d{1,3}\b/g, hint: '边缘节点出口 IP' }
]

/**
 * 公网 IP 检查
 *
 * 单独拆出来，因为它噪音大 —— 文档里写个代理地址、示例里写个公网 IP
 * 都是正常内容。默认只提示不阻断，加 --strict 才当错误处理。
 *
 * 内网与回环地址直接排除（127.0.0.1 / 10.x / 192.168.x / 172.16-31.x），
 * 它们不指向任何一台具体机器。
 */
const PUBLIC_IP_RULES = [
  { name: '公网 IP', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g }
]

/** 判断一个 IP 是否为内网/回环（不指向具体机器） */
function isPrivateIp (ip) {
  const p = ip.split('.').map(Number)
  if (p[0] === 127) return true                       // 回环
  if (p[0] === 10) return true                        // 10.0.0.0/8
  if (p[0] === 192 && p[1] === 168) return true        // 192.168.0.0/16
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true // 172.16.0.0/12
  if (p[0] === 169 && p[1] === 254) return true        // 链路本地
  if (p[0] === 0) return true                         // 0.0.0.0/8
  return false
}

/**
 * 路径黑名单 —— 整个目录都不该进仓库
 *
 * 这些是「工具的本机状态目录」，进去就是泄露源。
 */
const BLOCKED_PATHS = [
  { pattern: /(^|\/)\.wrangler\//, reason: 'wrangler 本机状态（含出口 IP / 地理位置）' },
  { pattern: /(^|\/)\.dev\.vars(\.|$)/, reason: 'Cloudflare 本地密钥' },
  { pattern: /(^|\/)\.env(\.|$)/, reason: '环境变量与密钥' },
  { pattern: /(^|\/)\.netlify\//, reason: 'Netlify 本机状态' },
  { pattern: /(^|\/)\.vercel\//, reason: 'Vercel 本机状态' },
  { pattern: /(^|\/)\.cache\//, reason: '构建缓存' },
  { pattern: /(^|\/)node_modules\//, reason: '依赖目录' },
  { pattern: /(^|\/)__pycache__\//, reason: 'Python 缓存' },
  { pattern: /\.sqlite(-shm|-wal)?$/, reason: '本地数据库状态' },
  { pattern: /(^|\/)wrangler-account\.json$/, reason: 'wrangler 账号信息' },
  { pattern: /(^|\/)cf\.json$/, reason: 'Cloudflare 网络诊断' }
]

/**
 * 扫描器自身
 *
 * 这两个文件里必然含有敏感模式的**字面量**
 * （比如规则写成 /"tlsClientRandom"/ 就会命中自己）。
 * 所以要排除掉 —— 但只排除内容检查，路径检查仍然生效。
 */
const SELF_FILES = new Set([
  'scripts/check-sensitive.js',
  'scripts/check-sensitive-history.js'
])

/** 二进制文件不扫内容（扫了也没意义，还可能误报） */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz',
  '.sqlite', '.db', '.mp3', '.mp4', '.woff', '.woff2', '.ttf', '.eot'
])

/** 单文件大小上限（MB）—— 超过多半是误入的产物 */
const MAX_FILE_MB = 2

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function run (cmd) {
  try {
    return execSync(cmd, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch (e) {
    return ''
  }
}

/**
 * 取要扫描的文件列表
 *
 * 返回 { abs, rel } 对：
 *   abs —— 绝对路径，用于读文件
 *   rel —— 展示用的路径（相对仓库根）
 *
 * 注意：跨盘符时 path.relative 会返回绝对路径
 * （Windows 上 G: → C: 会这样），
 * 所以读文件必须用 abs，不能拿 rel 再 join 回去。
 */
function listFiles (mode, dir) {
  if (mode === 'staged') {
    const out = run('git diff --cached --name-only --diff-filter=ACMR')
    return out
      ? out.split('\n').filter(Boolean).map(rel => ({
        abs: path.join(REPO_ROOT, rel),
        rel: rel
      }))
      : []
  }

  if (dir) {
    const abs = path.resolve(dir)
    const out = []
    const walk = (d) => {
      let entries
      try {
        entries = fs.readdirSync(d, { withFileTypes: true })
      } catch (e) {
        console.error('无法读取目录：' + d)
        return
      }
      for (const e of entries) {
        const full = path.join(d, e.name)
        if (e.isDirectory()) {
          if (e.name === '.git' || e.name === 'node_modules') continue
          walk(full)
        } else {
          const rel = path.relative(REPO_ROOT, full).replace(/\\/g, '/')
          out.push({
            abs: full,
            // 仓库外的文件用绝对路径展示，否则 relative 会给出
            // ../../.. 这种难读的串（跨盘符时甚至是完整绝对路径）
            rel: rel.startsWith('..') ? full.replace(/\\/g, '/') : rel
          })
        }
      }
    }
    walk(abs)
    return out
  }

  const out = run('git ls-files')
  return out
    ? out.split('\n').filter(Boolean).map(rel => ({
      abs: path.join(REPO_ROOT, rel),
      rel: rel
    }))
    : []
}

/** 读文件（返回 null 表示跳过） */
function readFile (abs) {
  if (!fs.existsSync(abs)) return null

  const st = fs.statSync(abs)
  if (st.isDirectory()) return null
  if (st.size > MAX_FILE_MB * 1024 * 1024) return null
  if (BINARY_EXT.has(path.extname(abs).toLowerCase())) return null

  try {
    const buf = fs.readFileSync(abs)
    // 含 NUL 字节 → 二进制
    if (buf.includes(0)) return null
    return buf.toString('utf8')
  } catch (e) {
    return null
  }
}

/** 找出匹配所在的行号与内容（脱敏后展示） */
function locate (text, pattern) {
  const lines = text.split('\n')
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
    if (re.test(line)) {
      // 展示时把匹配部分替换掉，避免二次泄露到日志/终端
      const masked = line.replace(re, (m) => '***' + m.slice(0, 4) + '***')
      hits.push({ line: i + 1, text: masked.trim().slice(0, 100) })
      re.lastIndex = 0
      if (hits.length >= 3) break
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main () {
  const argv = process.argv.slice(2)
  const mode = argv.includes('--staged') ? 'staged' : 'worktree'
  const strict = argv.includes('--strict')
  const dirIdx = argv.indexOf('--dir')
  const dir = dirIdx >= 0 ? argv[dirIdx + 1] : null

  const files = listFiles(mode, dir)

  const problems = []

  for (const f of files) {
    const rel = f.rel

    // ---- 路径黑名单 ----
    for (const bp of BLOCKED_PATHS) {
      if (bp.pattern.test(rel)) {
        problems.push({
          kind: '路径',
          level: 'error',
          file: rel,
          rule: bp.reason,
          detail: '该路径不应进仓库'
        })
        break
      }
    }

    const text = readFile(f.abs)
    if (text === null) continue

    // 扫描器自身跳过内容检查（规则定义里含有敏感模式的字面量）
    if (SELF_FILES.has(rel)) continue

    // ---- 凭据 ----
    for (const r of CREDENTIAL_RULES) {
      const hits = locate(text, r.pattern)
      if (hits.length) {
        problems.push({
          kind: '凭据',
          level: 'error',
          file: rel,
          rule: r.name,
          detail: hits.map(h => '第 ' + h.line + ' 行').join('、')
        })
      }
    }

    // ---- 环境泄露 ----
    for (const r of EXPOSURE_RULES) {
      const hits = locate(text, r.pattern)
      if (hits.length) {
        problems.push({
          kind: '环境',
          level: 'error',
          file: rel,
          rule: r.name,
          detail: hits.map(h => '第 ' + h.line + ' 行').join('、') + '（' + r.hint + '）'
        })
      }
    }

    // ---- 公网 IP（警告级）----
    for (const r of PUBLIC_IP_RULES) {
      const lines = text.split('\n')
      const hits = []
      for (let i = 0; i < lines.length; i++) {
        const re = new RegExp(r.pattern.source, 'g')
        let m
        while ((m = re.exec(lines[i])) !== null) {
          if (!isPrivateIp(m[0])) {
            hits.push({ line: i + 1, ip: m[0] })
            break
          }
        }
        if (hits.length >= 3) break
      }
      if (hits.length) {
        problems.push({
          kind: 'IP',
          level: strict ? 'error' : 'warn',
          file: rel,
          rule: r.name,
          detail: hits.map(h => '第 ' + h.line + ' 行 (' + h.ip + ')').join('、')
        })
      }
    }
  }

  // ---- 输出 ----
  const scope = mode === 'staged' ? '暂存区' : (dir ? ('目录 ' + dir) : '已跟踪文件')

  const errors = problems.filter(p => p.level !== 'warn')
  const warns = problems.filter(p => p.level === 'warn')

  if (!problems.length) {
    console.log('✓ 敏感信息扫描通过（' + scope + '，' + files.length + ' 个文件）')
    return 0
  }

  if (errors.length) {
    console.error('')
    console.error('✗ 发现 ' + errors.length + ' 处敏感信息（' + scope + '）')
    console.error('')
    for (const p of errors) {
      console.error('  [' + p.kind + '] ' + p.file)
      console.error('        规则：' + p.rule)
      console.error('        位置：' + p.detail)
      console.error('')
    }
    console.error('处理方式：')
    console.error('  · 本机状态文件 → 加进 .gitignore，并从索引移除：')
    console.error('      git rm -r --cached <路径>')
    console.error('  · 凭据 → 立即去服务商后台吊销并重新生成（改代码不够）')
    console.error('  · 已进历史 → 用 git-filter-repo 重写（见 docs/github-binding-research.md）')
    console.error('')
  }

  if (warns.length) {
    console.warn('! ' + warns.length + ' 处需要人工确认（' + scope + '）')
    console.warn('')
    for (const p of warns) {
      console.warn('  [' + p.kind + '] ' + p.file + ' — ' + p.rule)
      console.warn('        ' + p.detail)
    }
    console.warn('')
    console.warn('  确认无害可忽略；要当成错误处理请加 --strict')
    console.warn('')
  }

  return errors.length ? 1 : 0
}

process.exit(main())
