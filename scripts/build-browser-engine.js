/**
 * 浏览器版引擎打包器
 *
 * 问题：
 *   脱敏引擎现在是多个 CommonJS 模块（desensitize / name-detector /
 *   identifier-detector / institution-detector / pinyin-detector
 *   + 两份 JSON 词典）。
 *   浏览器没有 require —— 站点里的 <script src="desensitize.js"> 会直接挂掉。
 *
 * 做法：
 *   把依赖模块按依赖顺序**内联**进一个文件，
 *   用一个极简的模块注册表替代 require。
 *
 *   产物是单文件、零依赖、可直接 <script> 引入。
 *
 * 为什么不用打包器（webpack/rollup）：
 *   站点是纯静态的，引入构建链会让部署复杂化；
 *   而这里的依赖关系极简（5 个模块、无循环依赖），
 *   30 行代码就能搞定，不需要工具链。
 *
 * 用法：node scripts/build-browser-engine.js
 */
const fs = require('fs')
const path = require('path')

const HERE = __dirname
const SITE_DIR = path.join(HERE, '..', 'site')

/** 模块加载顺序 = 依赖顺序（被依赖的在前） */
const MODULES = [
  { file: 'name-detector.js', name: 'name-detector' },
  { file: 'identifier-detector.js', name: 'identifier-detector' },
  { file: 'institution-detector.js', name: 'institution-detector' },
  { file: 'pinyin-detector.js', name: 'pinyin-detector' },
  { file: 'desensitize.js', name: 'desensitize' }
]

/**
 * JSON 词典文件
 *
 * 每个词典会被注册成一个模块，模块名 = 文件名去掉 .json。
 * 这样 `require('./name-dict.json')` → `__require('name-dict')` 正好对上。
 */
const DICT_FILES = [
  'name-dict.json',
  'pinyin-dict.json'
]

/**
 * 把 CommonJS 源码转成浏览器可用的形式
 *
 * 只做两件事，顺序很重要：
 *
 * 1. **先**把 `if (typeof module !== 'undefined' && module.exports) {` 改成无条件
 *    —— 浏览器里 module 不存在，这个守卫会让导出赋值不执行。
 *    必须放在第 2 步之前，否则第 2 步把 `module.exports` 改掉后，
 *    这个正则就匹配不到了（这是本轮踩的坑）。
 *
 * 2. `require('./x')` → `__require('x')`
 *
 * `module.exports = X` **不需要改**：
 *   模块函数接收的是 module 对象，`module.exports = X` 改的是对象的属性，
 *   调用方拿到的就是它。语义与 CommonJS 完全一致。
 */
function transform (source) {
  let code = source

  // 1. 先处理 exports 守卫（必须在 require 替换之前）
  code = code.replace(
    /if\s*\(\s*typeof module\s*!==\s*['"]undefined['"]\s*&&\s*module\.exports\s*\)\s*\{/g,
    'if (true) {'
  )

  // 2. require → __require
  code = code.replace(/require\((['"])(\.[^'"]*)\1\)/g, function (m, q, p) {
    // './name-dict.json' → 'name-dict'
    const dep = p.replace(/^\.\//, '').replace(/\.json$/, '')
    return '__require(' + JSON.stringify(dep) + ')'
  })

  return code
}

function build () {
  const parts = []
  parts.push('/*')
  parts.push(' * PGrefuge 脱敏引擎（浏览器版）')
  parts.push(' *')
  parts.push(' * 由 scripts/build-browser-engine.js 自动生成，请勿手改。')
  parts.push(' * 源文件：scripts/desensitize.js + name-detector.js + identifier-detector.js')
  parts.push(' *')
  parts.push(' * 依赖已内联，无外部引用 —— 直接 <script> 引入即可。')
  parts.push(' */')
  parts.push(';(function () {')
  parts.push("  'use strict'")
  parts.push('')
  parts.push('  var __modules = {}')
  parts.push('  var __cache = {}')
  parts.push('  function __require (name) {')
  parts.push('    if (__cache[name]) return __cache[name].exports')
  parts.push('    var m = __cache[name] = { exports: {} }')
  parts.push('    var fn = __modules[name]')
  parts.push("    if (!fn) throw new Error('[PGDesensitize] missing module: ' + name)")
  parts.push('    // 模块里的 `module.exports = X` 改的是 m.exports 这个对象的属性，')
  parts.push('    // 调用方拿到的就是它 —— 与 CommonJS 语义一致。')
  parts.push('    fn(m)')
  parts.push('    return m.exports')
  parts.push('  }')
  parts.push('')

  for (const mod of MODULES) {
    const src = fs.readFileSync(path.join(HERE, mod.file), 'utf8')
    parts.push('  // ---- ' + mod.file + ' ----')
    parts.push('  __modules[' + JSON.stringify(mod.name) + '] = function (module) {')
    const body = transform(src)
    const indented = body.split('\n').map(function (l) { return l ? '    ' + l : l }).join('\n')
    parts.push(indented)
    parts.push('  }')
    parts.push('')
  }

  // JSON 词典作为 JS 对象内联
  //
  // 每个 JSON 词典单独注册成一个模块，
  // 这样 `require('./xxx-dict.json')` 会被 transform 成
  // `__require('xxx-dict')`，正好对应这里的注册名。
  for (const dictFile of DICT_FILES) {
    const dict = JSON.parse(fs.readFileSync(path.join(HERE, dictFile), 'utf8'))
    const modName = dictFile.replace(/\.json$/, '')
    parts.push('  // ---- ' + dictFile + ' ----')
    parts.push('  __modules[' + JSON.stringify(modName) + '] = function (module) {')
    parts.push('    module.exports = ' + JSON.stringify(dict))
    parts.push('  }')
    parts.push('')
  }

  parts.push('  // 暴露到全局')
  parts.push('  var DES = __require("desensitize")')
  parts.push('  window.PGDesensitize = DES')
  parts.push('})()')
  parts.push('')

  const out = parts.join('\n')
  const outPath = path.join(SITE_DIR, 'desensitize.js')
  fs.writeFileSync(outPath, out, 'utf8')

  console.log('[ok] 浏览器版引擎已生成')
  console.log('     输出: ' + outPath)
  console.log('     大小: ' + fs.statSync(outPath).size + ' bytes')
  console.log('     内联模块: ' +
    MODULES.map(function (m) { return m.file }).join(', ') +
    ', ' + DICT_FILES.join(', '))
}

build()
