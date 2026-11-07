#!/usr/bin/env node
/**
 * 敏感信息扫描 —— 当前文件树
 *
 * 规则定义在 check-sensitive-rules.js（与历史扫描、preflight 共用）。
 *
 * 用法
 * ----
 *   node scripts/check-sensitive.js                # 扫工作区已跟踪文件
 *   node scripts/check-sensitive.js --staged       # 只扫暂存区（pre-commit 用）
 *   node scripts/check-sensitive.js --dir <路径>   # 扫指定目录
 *   node scripts/check-sensitive.js --strict       # 公网 IP 也当错误
 *
 * 退出码：0 = 干净，1 = 发现问题
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const R = require('./check-sensitive-rules.js')

const REPO_ROOT = path.resolve(__dirname, '..')

/** 扫描器自身 —— 规则定义里含有敏感模式的字面量 */
const SELF_FILES = new Set([
  'scripts/check-sensitive.js',
  'scripts/check-sensitive-history.js',
  'scripts/check-sensitive-rules.js',
  'scripts/preflight.js'
])

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz',
  '.sqlite', '.db', '.mp3', '.mp4', '.woff', '.woff2', '.ttf', '.eot'
])

const MAX_FILE_MB = 2

function run (cmd) {
  try {
    return execSync(cmd, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch (e) {
    return ''
  }
}

/**
 * 取要扫描的文件列表
 *
 * 返回 { abs, rel } 对：
 *   abs —— 绝对路径，用于读文件
 *   rel —— 展示用的路径
 *
 * 注意：跨盘符时 path.relative 会返回绝对路径
 * （Windows 上 G: → C: 会这样），所以读文件必须用 abs。
 */
function listFiles (mode, dir) {
  if (mode === 'staged') {
    const out = run('git diff --cached --name-only --diff-filter=ACMR')
    return out
      ? out.split('\n').filter(Boolean).map(rel => ({ abs: path.join(REPO_ROOT, rel), rel }))
      : []
  }

  if (dir) {
    const abs = path.resolve(dir)
    const out = []
    const walk = d => {
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
    ? out.split('\n').filter(Boolean).map(rel => ({ abs: path.join(REPO_ROOT, rel), rel }))
    : []
}

function readFile (abs) {
  if (!fs.existsSync(abs)) return null
  const st = fs.statSync(abs)
  if (st.isDirectory()) return null
  if (st.size > MAX_FILE_MB * 1024 * 1024) return null
  if (BINARY_EXT.has(path.extname(abs).toLowerCase())) return null
  try {
    const buf = fs.readFileSync(abs)
    if (buf.includes(0)) return null
    return buf.toString('utf8')
  } catch (e) {
    return null
  }
}

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
    for (const bp of R.BLOCKED_PATHS) {
      if (bp.pattern.test(rel)) {
        problems.push({ kind: '路径', level: 'error', file: rel, rule: bp.reason, detail: '该路径不应进仓库' })
        break
      }
    }

    const text = readFile(f.abs)
    if (text === null) continue

    // 扫描器自身跳过内容检查（规则定义里含有敏感模式的字面量）
    if (SELF_FILES.has(rel)) continue

    const hits = R.scanText(text, rel, true)
    for (const h of hits) {
      problems.push({
        kind: h.kind,
        level: strict && h.level === 'warn' ? 'error' : h.level,
        file: rel,
        rule: h.rule,
        detail: '第 ' + h.line + ' 行' + (h.hint ? '（' + h.hint + '）' : '')
      })
    }
  }

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
    console.error('  · 位置/隐私信息 → 删掉或改写成不指向具体个人的形式')
    console.error('  · 已进历史 → 用 git-filter-repo 重写（见 docs/sensitive-info-guard.md）')
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
