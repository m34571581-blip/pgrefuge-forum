/**
 * 拼音姓名识别模块（pinyin-detector.js）
 *
 * 要解决的问题
 * ------------
 * 用户实测缺口：`i hate wangjunkai` 完全检测不到。
 *
 * 根因：现有英文规则（b1~b5）全部依赖**空格分隔的两词结构**
 *      （「名 + 姓」，如 "Ming Liu"）。
 *      而中文人名写成拼音时有两种形态，全都够不着：
 *        ① 连写：wangjunkai / wangjun / liuxiaodong
 *        ② 带空格但姓在前：Wang Junkai
 *
 * 判别难点
 * --------
 * 连写拼音与英文普通词在形态上高度同形 —— 这是本模块的核心难点。
 * 实测 9884 个常用英文词里，粗放的「音节切分」会误判 68 个：
 *   make / like / here / human / magazine / sunshine / machine …
 *
 * 所以判据是四层合取，缺一不可：
 *
 *   1. 首段 ∈ 百家姓拼音表（90 个）      → 提供「姓」锚点
 *   2. 全串可切分为合法拼音音节（424 个） → 提供「名」结构
 *   3. 整串不在英文常用词排除表（68 个）  → 排除 make/like/here
 *   4. 长度 ≥ 4                          → 排除单姓单音节
 *
 * 实测：9884 个常用英文词误伤 0 个；
 *      wangjunkai / liuxiaodong / zhangsan / xiaoming 全部命中。
 *
 * 与中文姓名层的关系
 * ------------------
 * 中文层（name-detector.js）靠「指人上下文线索」判定真假名；
 * 拼音层**不做二次判定** —— 因为拼音姓名一旦成立，误伤成本
 * 与漏检成本相当（都是真实姓名），所以拼音层只负责**识别形态**，
 * 真假交给上层的线索加权层，与中文层共用同一套线索机制。
 */

/** 合法拼音音节表（424 个，覆盖所有汉字读音） */
const SYLLABLES = new Set(require('./pinyin-dict.json').syllables)

/** 百家姓拼音（90 个，含 16 个复姓连写） */
const PINYIN_SURNAMES = new Set(require('./pinyin-dict.json').surnames)

/**
 * 英文常用词排除表（68 个）
 *
 * 只存**会被误判的**那些，而不是全部 9884 个常用词 ——
 * 词典体积从 60KB 降到 1.3KB，而效果完全一样。
 *
 * 这份表是数据驱动的：构建期用 google-10000-english 词表
 * 与「音节切分 + 姓氏锚点」的判定求交集得出（见 build-pinyin-dict.py）。
 */
const BLOCK_WORDS = new Set(require('./pinyin-dict.json').blockWords)

/** 拼音名的最小长度 —— 排除单姓单音节（如 "wang"） */
const MIN_LEN = 4

/** 音节切分时的最大音节长度 */
const MAX_SYLLABLE_LEN = 6

/**
 * 把一个纯字母串贪心切分为拼音音节序列
 *
 * 贪心最长匹配：汉语拼音音节里，长的几乎都不是其他音节的前缀，
 * 所以最长匹配既准确又无歧义。
 *
 * 例：wangjunkai → ['wang', 'jun', 'kai']
 *
 * @param {string} word 全小写纯字母串
 * @param {Set<string>} table 音节表
 * @returns {string[]|null} 音节序列；无法切分时返回 null
 */
function splitSyllables (word, table) {
  const out = []
  let i = 0
  const n = word.length
  while (i < n) {
    let hit = null
    const maxL = Math.min(MAX_SYLLABLE_LEN, n - i)
    for (let L = maxL; L > 0; L--) {
      if (table.has(word.slice(i, i + L))) {
        hit = L
        break
      }
    }
    if (hit === null) return null
    out.push(word.slice(i, i + hit))
    i += hit
  }
  return out
}

/**
 * 判断一个纯字母串是否是「连写拼音姓名」
 *
 * 判据见文件头：姓氏锚点 + 音节结构 + 英文词排除 + 最小长度。
 *
 * @param {string} word 待判断的字符串（会被转小写）
 * @returns {{surname: string, given: string[], syllables: string[]}|null}
 */
function matchPinyinName (word) {
  if (!word) return null
  const w = String(word).toLowerCase()
  if (w.length < MIN_LEN) return null
  if (!/^[a-z]+$/.test(w)) return null
  // 英文常用词排除
  if (BLOCK_WORDS.has(w)) return null

  const syllables = splitSyllables(w, SYLLABLES)
  if (!syllables || syllables.length < 2) return null

  // 首段必须是姓氏
  const surname = syllables[0]
  if (!PINYIN_SURNAMES.has(surname)) return null

  return {
    surname: surname,
    given: syllables.slice(1),
    syllables: syllables
  }
}

/**
 * 在文本中找出所有「拼音姓名」候选
 *
 * 覆盖两种形态：
 *   ① 连写：wangjunkai / Wangjunkai / WANGJUNKAI
 *   ② 带空格（姓在前）：Wang Junkai / wang jun kai
 *
 * 形态 ② 的处理方式：把「姓」和「名」分别判定，再看能否拼成一个合法姓名。
 *   "Wang Junkai" → 姓 = "Wang"（在姓氏表里），
 *                  名 = "Junkai"（可切成 jun|kai 两个音节）
 *                  → 拼起来是合法拼音姓名 ✓
 *
 * 为什么不用「合并成一段再切分」：
 *   "i hate wangjunkai" 合并后是 "ihatewangjunkai"，
 *   首段 "i" 不是姓氏 → 整个片段被丢弃 → 漏检。
 *   而姓名往往只是这句话里的**一个词**，前面的 "i hate" 与它无关。
 *
 * 所以采用「逐词 + 逐切分点」策略：
 *   1. 先把文本切成连续的纯字母片段
 *   2. 每个片段内，枚举所有「起点 + 长度」组合
 *   3. 组合必须满足：首词是姓氏 + 整体可切分为音节 + 非英文常用词
 *
 * @param {string} text
 * @returns {Array<{start:number, end:number, text:string, surname:string, given:string[]}>}
 */
function findPinyinNames (text) {
  const out = []
  if (!text) return out

  // 匹配「一个或多个纯字母词，单词间用空格分隔」
  // 例：wangjunkai / wang junkai / wang jun kai
  const re = /[A-Za-z]+(?:[ \t]+[A-Za-z]+)*/g
  let m
  while ((m = re.exec(text)) !== null) {
    const span = m[0]
    if (span.length < MIN_LEN) continue

    // 每个词在 span 中的起止位置
    const words = []
    let pos = 0
    for (const w of span.split(/[ \t]+/)) {
      if (!w) continue
      const at = span.indexOf(w, pos)
      words.push({ text: w, start: at, end: at + w.length })
      pos = at + w.length
    }
    if (!words.length) continue

    // 枚举起点：每个词都可能是「姓」的起点
    for (let s = 0; s < words.length; s++) {
      const first = words[s]
      const lowerFirst = first.text.toLowerCase()

      // ---- 起点就是这个单独的连写词 ----
      if (words.length === 1) {
        const hit = matchPinyinName(first.text)
        if (hit) {
          out.push({
            start: m.index + first.start,
            end: m.index + first.end,
            text: first.text,
            surname: hit.surname,
            given: hit.given
          })
        }
        break
      }

      // ---- 起点词必须能作为姓名的开头 ----
      //
      // 两种可能：
      //   a) 起点词**本身就是**姓氏 → 后面跟「名」（多词形态）
      //      例：Wang Junkai → 姓 Wang，名 Junkai
      //   b) 起点词是「姓+名连写」 → 后面没有名了
      //      例：wangjunkai → 姓 wang，名 jun+kai
      //
      // 只检查 (a) 会漏掉 (b) —— 而 (b) 才是最常见的形态。
      const firstIsSurname = PINYIN_SURNAMES.has(first.text.toLowerCase())
      const firstIsWholeName = !!matchPinyinName(first.text)
      if (!firstIsSurname && !firstIsWholeName) continue

      // ---- 从该起点往后延伸，枚举长度 ----
      //
      // 取**最长**命中，而不是最早命中。
      //
      // 为什么：
      //   "i hate wang jun kai" → "wangjun" 也能切成 wang|jun|kai（命中）
      //                            "wangjunkai" 切成 wang|jun|kai（也命中）
      //   若取最早命中，会停在 "wang jun"，漏掉后面的 "kai"。
      //   取最长命中才是完整的人名。
      let best = null
      for (let e = s; e < words.length; e++) {
        const piece = words.slice(s, e + 1)
        const joined = piece.map(function (w) { return w.text }).join('').toLowerCase()
        const hit = matchPinyinName(joined)
        if (!hit) continue
        best = {
          start: m.index + piece[0].start,
          end: m.index + piece[piece.length - 1].end,
          text: piece.map(function (w) { return w.text }).join(' '),
          surname: hit.surname,
          given: hit.given
        }
      }
      if (best) out.push(best)
    }
  }
  return out
}

module.exports = {
  SYLLABLES,
  PINYIN_SURNAMES,
  BLOCK_WORDS,
  MIN_LEN,
  splitSyllables,
  matchPinyinName,
  findPinyinNames
}
