/**
 * 敏感信息规则集 —— 供 check-sensitive.js / check-sensitive-history.js / preflight.js 共用
 *
 * 为什么单独抽出来：
 *   三个脚本需要同一套规则。之前是各写一份，改规则要改三处 —— 迟早会漏。
 *
 * 规则分级：
 *   ERROR  —— 命中即阻断（凭据、明确的本机环境信息）
 *   WARN   —— 命中只提示（公网 IP 等噪音大的，需人工判断）
 *
 * 关于「位置与隐私信息」：
 *   原始需求是「不要包含我的位置、隐私信息」。这比「凭据」宽得多 ——
 *   位置信息的形式也更多：经纬度、城市、运营商、IP、TLS 指纹、
 *   甚至文件名里的个人标识（"张三_简历.pdf"）。
 *   所以这里除了云厂商特有的字段，也加了通用检测。
 */

'use strict'

/**
 * 凭据 —— 命中即阻断
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
  { name: '私有钥', pattern: /-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g },
  { name: 'Authorization 头', pattern: /["']?Authorization["']?\s*[:=]\s*["']Bearer\s+[A-Za-z0-9._-]{20,}/gi },
  { name: '通用 api_key 赋值', pattern: /\bapi[_-]?key\s*[:=]\s*["'][A-Za-z0-9_-]{24,}/gi },
  { name: '通用 secret 赋值', pattern: /\b(secret|password|passwd|token)\s*[:=]\s*["'][^"'\s]{16,}["']/gi },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'JSON Web Token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g }
]

/**
 * 本机环境与位置信息 —— 命中即阻断
 *
 * 关键点：要求「字段名 + 冒号 + 非空值」同时出现。
 * 纯提及字段名（文档里写「我们检查了 tlsClientRandom 字段」）不算泄露。
 */
const EXPOSURE_RULES = [
  // ---- 云厂商边缘诊断（值必须是具体值）----
  { name: 'Cloudflare 边缘节点诊断', pattern: /"colo"\s*:\s*"[A-Z]{3}"/g, hint: '出口节点位置' },
  { name: 'Cloudflare TLS 握手随机数', pattern: /"tlsClientRandom"\s*:\s*"[^"]{8,}"/g, hint: '网络会话指纹' },
  { name: 'ASN 运营商信息', pattern: /"asOrganization"\s*:\s*"[^"]{3,}"/g, hint: '网络服务商' },

  // ---- 通用地理位置 ----
  // key 允许带引号或不带（JS 对象两种写法都常见），值必须带引号且非空
  { name: '地理位置字段', pattern: /["']?(city|region|province|state|country|latitude|longitude|lat|lng|lon|geo|zipcode|postal_code)["']?\s*:\s*["'][^"']{1,}["']/gi, hint: '地理位置' },
  { name: '经纬度坐标', pattern: /\b(?:3[0-9]|[1-5]?\d)\.\d{4,}\s*[,，]\s*(?:1[0-9]{2}|1[0-2]\d|[1-9]?\d)\.\d{4,}\b/g, hint: '精确坐标' },
  { name: 'IP 地理位置字段（嵌套）', pattern: /"ip"\s*:\s*"(?:\d{1,3}\.){3}\d{1,3}"/g, hint: '出口 IP' },

  // ---- 网络指纹类 ----
  { name: 'Cloudflare 边缘出口 IP', pattern: /\b162\.159\.\d{1,3}\.\d{1,3}\b/g, hint: '边缘节点出口 IP' },
  { name: 'Cloudflare 出口 IP 段', pattern: /\b104\.1[6-9]\.\d{1,3}\.\d{1,3}\b|\b172\.64\.\d{1,3}\.\d{1,3}\b/g, hint: 'CDN 出口 IP' },
  { name: 'TLS 指纹字段', pattern: /"(ja3|ja4|tls[A-Za-z]*Fingerprint|akamaiFingerprint)"\s*:/gi, hint: '设备指纹' },
  { name: '设备指纹字段', pattern: /"(device[_-]?id|device[_-]?fingerprint|visitor[_-]?id|client[_-]?id)"\s*:\s*"[^"]{4,}"/gi, hint: '设备标识' },

  // ---- 个人隐私类 ----
  { name: '身份证号', pattern: /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, hint: '中国身份证号' },
  { name: '手机号', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, hint: '中国大陆手机号' },
  { name: '银行卡号', pattern: /\b\d{16,19}\b/g, hint: '疑似银行卡号' },
  { name: '护照号', pattern: /\b[A-Z]{1,2}\d{6,9}\b/g, hint: '疑似护照号' },
  // 裸邮箱 —— 不管有没有中文名，邮箱本身就是可定位个人的标识
  // （之前只有「邮箱 + 中文姓名」那条，导致 「某真实邮箱」 这类漏报）
  { name: '邮箱地址', pattern: /(?<![@\w.+-])[\w.+-]{2,}@[\w-]{1,}(?:\.[\w-]{2,})+(?![@\w])/g, hint: '可定位到个人' },
  { name: '邮箱 + 真实姓名的组合', pattern: /[一-龥]{2,4}\s*[<（(]?\s*[\w.+-]+@[\w-]+\.[\w.]+\s*[>）)]?/g, hint: '姓名与邮箱同现' }
]

/**
 * 公网 IP —— 只警告
 *
 * 内网与回环排除（不指向任何一台具体机器）。
 * 默认只提示不阻断 —— 文档里写个代理地址是正常内容，
 * 天天误报的话没人会看检查结果。
 */
const PUBLIC_IP_RULES = [
  { name: '公网 IP', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g }
]

function isPrivateIp (ip) {
  const p = ip.split('.').map(Number)
  if (p[0] === 127) return true
  if (p[0] === 10) return true
  if (p[0] === 192 && p[1] === 168) return true
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
  if (p[0] === 169 && p[1] === 254) return true
  if (p[0] === 0) return true
  return false
}

/**
 * 路径黑名单 —— 整个路径不该进仓库
 */
const BLOCKED_PATHS = [
  { pattern: /(^|\/)\.wrangler\//, reason: 'wrangler 本机状态（含出口 IP / 地理位置）' },
  { pattern: /(^|\/)\.dev\.vars(\.|$)/, reason: 'Cloudflare 本地密钥' },
  { pattern: /(^|\/)\.env(\.|$)/, reason: '环境变量与密钥' },
  { pattern: /(^|\/)\.netlify\//, reason: 'Netlify 本机状态' },
  { pattern: /(^|\/)\.vercel\//, reason: 'Vercel 本机状态' },
  { pattern: /(^|\/)\.firebase\//, reason: 'Firebase 本机状态' },
  { pattern: /(^|\/)\.cache\//, reason: '构建缓存' },
  { pattern: /(^|\/)node_modules\//, reason: '依赖目录' },
  { pattern: /(^|\/)__pycache__\//, reason: 'Python 缓存' },
  { pattern: /(^|\/)\.workbuddy\//, reason: 'WorkBuddy 本地状态' },
  { pattern: /\.sqlite(-shm|-wal)?$/i, reason: '本地数据库状态' },
  { pattern: /\.(db|pem|key|p12|pfx)$/i, reason: '数据库或密钥文件' },
  { pattern: /(^|\/)wrangler-account\.json$/i, reason: 'wrangler 账号信息' },
  { pattern: /(^|\/)cf\.json$/i, reason: 'Cloudflare 网络诊断' }
]

/**
 * 豁免标记
 *
 * 有些地方必然出现敏感模式的字面值：
 *   - 文档里展示违规写法
 *   - 脱敏引擎的测试样本集（故意包含手机号/邮箱格式，用来验证识别能力）
 *
 * 用法：行末加 `pgrefuge:allow-sensitive`。
 *
 * **单行豁免** —— 只跳过标记所在的那一行。
 *
 * **块豁免** —— 标记后连续的缩进块也跳过。实现方式：
 *   标记行之后，后续行只要缩进比标记行更深，就一起跳过；
 *   遇到缩进变浅或空行则结束。
 *
 * 这样测试样本数组只要在声明处标一次，整个数组都不用逐行标注。
 *
 * 豁免是显式的 —— 每加一个都要有人判断过。
 */
const ALLOW_MARK = 'pgrefuge:allow-sensitive'

/**
 * 已知占位值白名单
 *
 * 这些字符串**看起来**像个人信息，但都是公开的标准占位值，
 * 不指向任何真实的人：
 *   - 13800138000 —— 中国联通的标准测试号段
 *   - example.edu.cn / example.com —— RFC 2606 保留域名
 *
 * 脱敏引擎的测试集必须包含它们（否则测不出识别能力），
 * 所以这里做精确白名单，而不是用整块豁免掩盖问题。
 *
 * 注意：白名单是**精确匹配**，不是前缀/模式 ——
 * 前缀匹配会让 13800138001 这类也被放过，防线就松了。
 */
const PLACEHOLDER_VALUES = new Set([
  '13800138000',
  '13800138001',
  '13800138002',
  '13800138003',
  '13800138004',
  '13800138005',
  '13800138006',
  '13800138007',
  '13800138008',
  '13800138009'
])

/** 占位域名 */
const PLACEHOLDER_DOMAINS = [
  'example.com',
  'example.net',
  'example.org',
  'example.edu',
  'example.edu.cn',
  'xxx.edu.cn',
  'test.com',
  'localhost'
]

/**
 * 判断一行里出现的敏感值是否全是占位值
 *
 * @param {string} line
 * @returns {boolean} true = 这一行的命中全是占位值，可以放过
 */
function isOnlyPlaceholders (line) {
  // 把行里所有「像敏感值的片段」提取出来，逐个判断
  const candidates = []

  // 手机号
  const phoneRe = /(?<!\d)1[3-9]\d{9}(?!\d)/g
  let m
  while ((m = phoneRe.exec(line)) !== null) candidates.push(m[0])

  // 邮箱
  const mailRe = /[\w.+-]+@[\w.-]+\.\w+/g
  while ((m = mailRe.exec(line)) !== null) candidates.push(m[0])

  if (!candidates.length) return false

  return candidates.every(c => {
    if (PLACEHOLDER_VALUES.has(c)) return true
    const at = c.indexOf('@')
    if (at > 0) {
      const domain = c.slice(at + 1).toLowerCase()
      return PLACEHOLDER_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))
    }
    return false
  })
}

/**
 * 计算每一行是否被豁免
 *
 * 块豁免的边界判定：**遇到新的顶层声明就结束**。
 *
 * 为什么不用缩进判断：注释行通常缩进为 0，而它保护的数组元素缩进为 2 ——
 * 按缩进判断的话，块在注释之后就结束了，豁免形同虚设。
 *
 * 实际的边界是「下一个顶层声明」：
 *   - 以非空白字符开头（缩进 0）且看起来是代码（不是注释）
 *   - 即 `const` / `let` / `var` / `function` / `class` / `}` 等
 *
 * 这样「标记注释 + 紧随其后的数组」整块都被豁免，
 * 而下一个数组开始时豁免自动结束。
 *
 * @param {string[]} lines
 * @returns {boolean[]} 与 lines 等长，true 表示该行豁免
 */
function computeAllowMask (lines) {
  const mask = new Array(lines.length).fill(false)

  // 顶层代码行（非注释、非空、非空白开头）
  const isTopLevelCode = line => {
    const t = line.trim()
    if (!t) return false
    if (t.startsWith('//')) return false
    if (t.startsWith('/*') || t.startsWith('*')) return false
    return line.length === line.trimStart().length
  }

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(ALLOW_MARK)) continue

    // 标记行本身豁免
    mask[i] = true

    // 向后延伸，直到遇到下一个顶层代码行
    for (let j = i + 1; j < lines.length; j++) {
      if (isTopLevelCode(lines[j])) break
      mask[j] = true
    }
  }

  return mask
}

/**
 * 扫描一段文本，返回命中列表
 *
 * @param {string} text
 * @param {string} label  用于提示里说明扫的是哪里
 * @param {boolean} includeWarn 是否把警告级规则也算进来
 */
function scanText (text, label, includeWarn) {
  const hits = []
  const lines = text.split('\n')
  const allowMask = computeAllowMask(lines)

  const all = []
    .concat(CREDENTIAL_RULES.map(r => ({ ...r, kind: '凭据', level: 'error' })))
    .concat(EXPOSURE_RULES.map(r => ({ ...r, kind: '环境', level: 'error' })))

  if (includeWarn) {
    all.push(...PUBLIC_IP_RULES.map(r => ({ ...r, kind: 'IP', level: 'warn' })))
  }

  for (const rule of all) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (allowMask[i]) continue

      // 整行都是公开占位值 → 放过（测试语料常见形态）
      if (isOnlyPlaceholders(line)) continue

      re.lastIndex = 0
      const m = line.match(re)
      if (!m) continue

      // 公网 IP 要排除内网
      if (rule.kind === 'IP') {
        const ips = m.filter(x => !isPrivateIp(x))
        if (!ips.length) continue
        hits.push({ rule: rule.name, line: i + 1, kind: rule.kind, level: rule.level, hint: rule.hint })
        continue
      }
      hits.push({ rule: rule.name, line: i + 1, kind: rule.kind, level: rule.level, hint: rule.hint })
      break // 每条规则每个文件只报一次
    }
  }

  return hits
}

module.exports = {
  CREDENTIAL_RULES,
  EXPOSURE_RULES,
  PUBLIC_IP_RULES,
  BLOCKED_PATHS,
  ALLOW_MARK,
  isPrivateIp,
  computeAllowMask,
  isOnlyPlaceholders,
  scanText
}
