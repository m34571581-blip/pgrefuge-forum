/**
 * 标识符识别模块（identifier-detector.js）
 *
 * 为什么需要它：
 *   姓名之外，还有大量**非姓名但同样能定位到个人**的信息 ——
 *   学号、工号、手机号、邮箱、QQ/微信号、办公室房间号。
 *
 *   这些信息的特点与姓名完全不同：
 *     姓名 —— 形态不可判定，必须靠上下文（见 name-detector.js）
 *     标识符 —— **格式高度规整**，可以用正则可靠识别
 *
 *   所以两类要分开做，不能塞进同一套规则里。
 *
 * 核心设计：**关键词 + 格式**双重约束
 *
 *   只匹配格式会误伤：
 *     "2024年"      → 4 位数字，不是学号
 *     "120分"       → 3 位数字，不是学号
 *     "第3章"       → 数字，不是房间号
 *
 *   只匹配关键词不够 —— 必须同时验证格式。
 *   所以规则形如：「学号/工号/学号是 + 8~12 位数字」。
 *
 *   这让误伤率极低，同时对真实场景的覆盖很全 ——
 *   人在吐槽时提到学号/手机号，前面几乎总有引导词。
 */

// ---- 各类标识符的规则 ----

/**
 * 学号 / 工号 / 研究生号
 *
 * 格式：8~12 位数字，且**必须有引导词**。
 * 没有引导词的纯数字串一律不动 —— 否则 "2024"、"120" 会被误伤。
 */
const STUDENT_ID = [
  '学号', '工号', '学生号', '研究生号', '学号是', '工号是', '编号是'
]

/**
 * 手机号
 *
 * 格式：中国大陆手机号 1[3-9]xxxxxxxxx，共 11 位。
 * 必须有引导词 —— 裸的 11 位数字可能是订单号、快递单号。
 */
const PHONE_HINT = [
  '手机', '电话', '手机号', '电话号码', '联系方式', '联系', 'TEL', 'tel',
  'Phone', 'phone', 'Mobile', 'mobile', 'Call', 'call'
]

/**
 * 邮箱
 *
 * 格式本身就是强信号（必须有 @ 和域名），所以可以放宽引导词要求。
 * 但仍要求「@ 前是标识符形态」，避免误伤 "@微信" 这类口语用法。
 */
const EMAIL_HINT = [
  '邮箱', '邮件', 'email', 'Email', 'EMAIL', 'e-mail', 'E-mail',
  'mail', 'Mail', 'MAIL', '发到', '发给我'
]

/**
 * QQ / 微信 / 社交账号
 */
const SOCIAL_HINT = [
  'QQ', 'qq', 'Qq', '微信', 'wechat', 'WeChat', 'Wechat', 'WECHAT',
  '微博', 'weibo', '小红书', '抖音', '钉钉', 'WhatsApp', 'Telegram'
]

/**
 * 房间号 / 工位 / 办公室
 *
 * 格式：「楼 + 房号」或「楼 - 房号」，房号是 1~4 位数字。
 * 必须有引导词（楼/室/房间/办公室/工位/实验室在…楼）。
 */
const ROOM_HINT = [
  '房间', '办公室', '工位', '座位', '教室', '实验室在', '办公室在',
  '工位在', '房间号', '办公室号', '工位号', '在', 'Room', 'room',
  'Office', 'office', 'Lab', 'lab', 'Desk', 'desk'
]

/**
 * 明确的房间类提示词
 *
 * ROOM_HINT 里的「在」太宽 —— 「他在5楼」也会命中，会误伤。
 * 所以纯数字房间号要用更严格的提示词：必须明确说这是房间/工位/办公室。
 */
const ROOM_STRONG_HINT = [
  '房间号', '房间', '办公室号', '办公室', '工位号', '工位', '座位号', '座位',
  '教室', 'Room', 'room', 'Office', 'office', 'Desk', 'desk', 'Lab', 'lab'
]

// ---- 正则 ----

const RE_STUDENT_ID = /\b\d{8,12}\b/g
// 手机号：中国大陆格式 1XX XXXX XXXX（3-4-4）
// 三种写法都覆盖：13800138000 / 138-0013-8000 / 138 0013 8000  // pgrefuge:allow-sensitive
//
// 边界用 (?<!\d) / (?!\d) 而不是 \b ——
// \b 在「数字-数字」之间不成立（连字符是非单词字符，但 \b 看的是 \w），
// 会导致带分隔符的写法完全匹配不上。
const RE_PHONE = /(?<!\d)1[3-9]\d(?:[-\s]?\d{4}){2}(?!\d)/g
const RE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
// 社交账号：字母型（微信/wechat）+ 数字型（QQ 号）
const RE_SOCIAL_ALPHA = /\b[A-Za-z][A-Za-z0-9_-]{4,19}\b/g
const RE_SOCIAL_NUM = /\b[1-9]\d{4,10}\b/g
// 房间号：楼-房号（5-317）或纯房号（402，带引导词时）
const RE_ROOM_RANGE = /\b\d{1,4}\s*-\s*\d{1,4}\b/g
const RE_ROOM_PLAIN = /\b\d{1,4}\b/g

/**
 * 判断在给定位置之前是否有提示词
 *
 * @param {string} text  全文
 * @param {number} pos   匹配起始位置
 * @param {string[]} hints 提示词表
 * @param {number} window 回看窗口（字符数）
 */
function hasHintBefore (text, pos, hints, window) {
  const w = window || 12
  const before = text.slice(Math.max(0, pos - w), pos)
  for (const h of hints) {
    if (before.indexOf(h) !== -1) return h
  }
  return null
}

/**
 * 识别文本中的标识符类敏感信息
 *
 * @returns {Array<{start, end, text, kind, hint}>}
 */
function findIdentifiers (text) {
  const out = []

  // ---- 学号 / 工号 ----
  let m
  RE_STUDENT_ID.lastIndex = 0
  while ((m = RE_STUDENT_ID.exec(text)) !== null) {
    // 8~12 位数字，排除手机号（11位且 1 开头）—— 手机号由手机规则处理
    if (m[0].length === 11 && /^1[3-9]/.test(m[0])) continue
    const hint = hasHintBefore(text, m.index, STUDENT_ID, 8)
    if (hint) {
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0], kind: 'studentId', hint: hint })
    }
  }

  // ---- 手机号 ----
  RE_PHONE.lastIndex = 0
  while ((m = RE_PHONE.exec(text)) !== null) {
    const hint = hasHintBefore(text, m.index, PHONE_HINT, 10)
    if (hint) {
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0], kind: 'phone', hint: hint })
    }
  }

  // ---- 邮箱 ----
  RE_EMAIL.lastIndex = 0
  while ((m = RE_EMAIL.exec(text)) !== null) {
    // 邮箱格式本身很强，但要求前面有提示词或 @ 前是完整标识符
    const hint = hasHintBefore(text, m.index, EMAIL_HINT, 12)
    if (hint) {
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0], kind: 'email', hint: hint })
    }
  }

  // ---- QQ / 微信 ----
  // 字母型账号
  RE_SOCIAL_ALPHA.lastIndex = 0
  while ((m = RE_SOCIAL_ALPHA.exec(text)) !== null) {
    const hint = hasHintBefore(text, m.index, SOCIAL_HINT, 10)
    if (hint) {
      // 排除与邮箱重复的
      const isEmail = out.some(function (o) {
        return o.kind === 'email' && m.index >= o.start && m.index < o.end
      })
      if (!isEmail) {
        out.push({ start: m.index, end: m.index + m[0].length, text: m[0], kind: 'social', hint: hint })
      }
    }
  }
  // 数字型账号（QQ 号）
  RE_SOCIAL_NUM.lastIndex = 0
  while ((m = RE_SOCIAL_NUM.exec(text)) !== null) {
    // 排除已被学号/手机号认领的数字
    const taken = out.some(function (o) {
      return (o.kind === 'studentId' || o.kind === 'phone') &&
        m.index >= o.start && m.index < o.end
    })
    if (taken) continue
    const hint = hasHintBefore(text, m.index, SOCIAL_HINT, 10)
    if (hint) {
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0], kind: 'social', hint: hint })
    }
  }

  // ---- 房间号 ----
  // 带楼栋区号的（5-317）
  RE_ROOM_RANGE.lastIndex = 0
  while ((m = RE_ROOM_RANGE.exec(text)) !== null) {
    const hint = hasHintBefore(text, m.index, ROOM_HINT, 10)
    if (hint) {
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0], kind: 'room', hint: hint })
    }
  }
  // 纯房号（402）—— 必须有明确的房间/工位类提示词
  RE_ROOM_PLAIN.lastIndex = 0
  while ((m = RE_ROOM_PLAIN.exec(text)) !== null) {
    const taken = out.some(function (o) {
      return (o.kind === 'studentId' || o.kind === 'phone' || o.kind === 'social' || o.kind === 'room') &&
        m.index >= o.start && m.index < o.end
    })
    if (taken) continue
    // 提示词必须**明确指向房间**（不能用宽泛的「在」）
    const hint = hasHintBefore(text, m.index, ROOM_STRONG_HINT, 8)
    if (hint) {
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0], kind: 'room', hint: hint })
    }
  }

  // 排序并去重（同一区间只保留先出现的）
  out.sort(function (a, b) { return a.start - b.start })
  const dedup = []
  for (const o of out) {
    if (dedup.length && o.start < dedup[dedup.length - 1].end) continue
    dedup.push(o)
  }
  return dedup
}

module.exports = {
  STUDENT_ID, PHONE_HINT, EMAIL_HINT, SOCIAL_HINT, ROOM_HINT, ROOM_STRONG_HINT,
  hasHintBefore,
  findIdentifiers
}
