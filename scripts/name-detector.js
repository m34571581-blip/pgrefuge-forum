/**
 * 姓名识别模块（name-detector.js）
 *
 * 为什么单独成文件：
 *   脱敏引擎（desensitize.js）原本是「单层正则级联」——
 *   靠机构词表 + 称谓表 + 正则的级联替换来识别敏感信息。
 *   这套结构的天花板就是词表本身：词表里没有的，就漏。
 *
 *   用户实测暴露了两个硬缺口：
 *     ① 英文姓名的任意大小写（Mr.liu / mr. LIU / Ming Liu）
 *     ② 中文姓名不带职称（王小明）
 *
 *   补这两个缺口靠继续加正则是填无底洞 —— 因为：
 *     中文「无职称纯姓名」在形态上与普通词几乎无法区分。
 *     实测（115 万字真实语料、6.2 万片段）：
 *       纯形态判别对「王小明」这类命中 86.7%，但对真实语料误判 1.48%；
 *       更严重的是人工抽样里真名 : 普通词 ≈ 41 : 37 —— 等于随机。
 *
 *   所以正确做法不是「更强的正则」，而是**换判据**：
 *   从「形态像不像名字」改成「**这个词组在句子里是不是在指人**」。
 *
 * 三层识别架构：
 *
 *   L1 确定性锚定  —— 有明确的结构信号（称谓、姓氏前缀、关系词）
 *                      命中即脱敏，置信度高。
 *
 *   L2 上下文加权  —— 形态上像名字（姓 + 名字用字），
 *                      且**附近出现指人线索**（动作动词、关系词、代词）。
 *                      两者都满足才脱敏。这是识别「王小明」的主力。
 *
 *   L3 兜底告警    —— 形态可疑但线索不足时，**不静默放过**，
 *                      而是把片段标记为「疑似敏感」交给前端提示用户。
 *                      这一层不自动替换 —— 因为误伤代价高；
 *                      但也绝不放过 —— 因为漏检代价更高。
 *
 * L3 是这套架构的关键：它把「引擎不知道」从「静默失败」变成「显式告警」。
 * 用户能看到「这里可能有 2 处姓名未脱敏」，而不是发出去才发现。
 */

// ---- 数据 ----

/** 姓氏（人口覆盖前 80，覆盖绝大多数中国人） */
const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许邓冯韩曹曾彭萧蔡潘田董袁余叶蒋杜苏魏程吕丁沈任姚卢傅钟姜崔谭廖范汪陆金石戴贾韦夏邱方侯邹熊孟秦白江阎薛尹段雷'

/** 复姓 */
const COMPOUND_SURNAMES = [
  '欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '尉迟', '公孙',
  '慕容', '长孙', '宇文', '司徒', '司空', '端木', '南宫', '夏侯'
]

/**
 * 常用名字用字（1209 字）
 *
 * 来源：合并两个基于真实人名库统计的公开起名工具，
 *       抓取其「取名常用字」列表（见 build-name-dict.py）。
 *       这比手写白名单可靠 —— 它是数据驱动的产物。
 */
const NAME_CHARS = require('./name-dict.json').nameChars

/** 常见普通词排除（姓 + 字但不是人名的组合） */
const BLOCK_BIGRAMS = new Set([
  '方面', '方向', '方案', '方法', '方程', '程度', '工程', '成功', '成果',
  '白天', '明白', '明天', '昨天', '今日', '去年', '今年', '每月', '每天',
  '马路', '马上', '马桶', '马车', '马力', '云龙', '云飞', '毛巾', '毛病',
  '老虎', '兔子', '猴子', '狮子', '车子', '桌子', '房子', '叶子', '花生',
  '水果', '米饭', '面粉', '战争', '战士', '武力', '日记', '日期', '时候',
  '时间', '钟表', '钟声', '唐山', '武汉', '成都', '南京', '北京', '上海',
  '广州', '长江', '黄河', '白色', '百事', '百姓', '百分', '百年', '千万',
  '万一', '问题', '风机', '闪电', '雷鸣', '雷达', '雪山', '雷区', '范围',
  '章程', '于是', '何况', '何时', '姓王', '余下', '段落', '台阶', '任务',
  '任命', '任何', '主任', '何塞', '何礼', '余部', '余座', '夏代', '夏季',
  '宋代', '唐初', '唐朝', '明朝', '元朝', '汉朝', '民国', '唐代', '古代',
  '现代', '当代', '近代', '上代', '下代', '千代', '万代', '迭代', '存款',
  '存量', '定向', '定期', '定点', '定位', '定时', '定量', '定性', '定律',
  '定额', '定价', '定制', '定义', '定理', '任制', '任嚣', '余米', '余艘',
  '叶城', '叶林', '卢山', '卢曼', '尹力', '崔杏', '任中共', '任中国'
])

/**
 * 指人线索（前缀）—— 出现在姓名**之前**，说明后面在指人
 *
 * 这些词分三类：
 *   自称类：我是 / 我叫 —— 说话人在报自己的名字
 *   引述类：他叫 / 她叫 —— 转述别人的名字
 *   动作类：骂 / 批评 / 针对 —— 对人施加动作
 */
const CUE_BEFORE = [
  '我是', '我叫', '我的名字叫', '我的名字是', '名字叫', '名字是',
  '他叫', '她叫', '它叫', '他们叫', '大家叫',
  '骂', '批评', '指责', '催', '逼', '卷', '折磨', '折腾', '针对', '针对我',
  '找', '问', '要求', '命令', '通知', '感谢', '恭喜', '同情'
]

/**
 * 指人线索（后缀）—— 出现在姓名**之后**，说明前面在指人
 *
 * 最有力的是「动作动词」和「关系词」：
 *   王小明说 / 王强骂 / 张三的导师 / 刘洋让我
 *   张三是我的导师 —— 「是我的导师」是最强信号
 */
const CUE_AFTER = [
  '说', '讲', '骂', '吼', '叫', '让', '命令', '要求', '批评', '指责',
  '催', '逼', '卷', '折磨', '折腾', '找', '问', '的通知', '的消息',
  // 「X是Y」句式 —— Y 是人名时，X 通常是身份（导师/师兄/老板）
  '是',
  '的导师', '的师兄', '的师姐', '的师弟', '的师妹', '的老板', '的领导',
  '的同事', '的老板', '的室友', '的朋友', '的微信', '的邮箱', '的QQ',
  '是我', '是咱', '是那', '把', '会', '真', '就', '也', '却', '还',
  '又', '总', '从来', '一直', '每次', '每天', '什么', '为什么', '怎么'
]

/** 强关系词 —— 出现即可基本确认前面是人名 */
const STRONG_RELATION = [
  '我的导师', '我的老师', '我的师兄', '我的师姐', '我的师弟',
  '我的师妹', '我的老板', '我的领导', '我的同事', '我的室友', '我的朋友',
  '是我导师', '是我老师', '是我师兄', '是我师姐', '是我老板', '是我领导',
  '是我的导师', '是我的老师', '是我的师兄', '是我的师姐', '是我的老板',
  '是我的领导', '是我的同事', '是我室友', '是我朋友', '是我的室友',
  // 「X是Y」—— Y 在这些身份位置上就是人名
  '导师是', '老师是', '师兄是', '师姐是', '师弟是', '师妹是',
  '老板是', '领导是', '同事是', '室友是', '朋友是', '博士是', '博导是'
]

/** 名字用字集合（加速查询） */
const NAME_CHAR_SET = new Set(NAME_CHARS)

/** 姓氏集合 */
const SURNAME_SET = new Set(SURNAMES.split(''))

/**
 * 判断一个中文字符串是否具备「姓名形态」
 *
 * 条件：
 *   1. 以姓氏或复姓开头
 *   2. 剩余部分 1~2 个字，且每字都在名字用字表里
 *   3. 整体不在常见普通词排除表里
 *
 * 注意：这一步只判断「形态」，不判断「是不是真名」。
 *      真假的判断交给上下文加权层。
 */
function hasNameShape (span) {
  if (!span || span.length < 2 || span.length > 4) return false
  if (BLOCK_BIGRAMS.has(span)) return false

  let rest = ''
  const compound = COMPOUND_SURNAMES.find(function (s) { return span.indexOf(s) === 0 })
  if (compound) {
    rest = span.slice(compound.length)
  } else {
    if (!SURNAME_SET.has(span[0])) return false
    rest = span.slice(1)
  }

  if (!rest || rest.length > 2) return false
  for (const ch of rest) {
    if (!NAME_CHAR_SET.has(ch)) return false
  }
  return true
}

/**
 * 单字名的判定（张三、李四、王五）
 *
 * 单字名在名字用字表里覆盖不到（三、四、六、七 都不是取名用字），
 * 但它们确实是真实的姓名形态（「张三是我的导师」）。
 *
 * 判据：姓氏 + 中文数字 / 天干地支 / 常见单字名用字。
 *       「张三」既是名字也是泛指，所以**只靠形态不够，必须有上下文**。
 */
const SINGLE_NAME_TAILS = new Set(
  '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥' +
  '伟芳娜秀英敏静丽强磊军洋勇艳杰娟涛超霞平刚桂辉玲兰凤琴斌凯峰旭波宁健俊'
)

function hasSingleNameShape (span) {
  if (!span || span.length !== 2) return false
  if (BLOCK_BIGRAMS.has(span)) return false
  if (!SURNAME_SET.has(span[0])) return false
  return SINGLE_NAME_TAILS.has(span[1])
}

/**
 * 宽松形态：姓氏 + 任意 1~2 个汉字
 *
 * 只在**有强上下文线索**时使用。
 * 因为这时上下文已经提供了足够强的信号（比如「是我的导师」），
 * 形态只需要保证「不像普通词」即可。
 */
function hasLooseNameShape (span) {
  if (!span || span.length < 2 || span.length > 4) return false
  if (BLOCK_BIGRAMS.has(span)) return false

  const compound = COMPOUND_SURNAMES.find(function (s) { return span.indexOf(s) === 0 })
  if (compound) {
    const rest = span.slice(compound.length)
    return rest.length >= 1 && rest.length <= 2
  }
  if (!SURNAME_SET.has(span[0])) return false
  const rest = span.slice(1)
  return rest.length >= 1 && rest.length <= 2
}

/**
 * 在文本中找出所有具备姓名形态的中文片段
 *
 * 切分策略：**锚定姓氏 + 最长优先**
 *
 * 不能用 `/[\u4e00-\u9fa5]{2,4}/g` 这种「按最大长度切块」的方式 ——
 * 那样「我是王小明」会被切成「我是王小」，真正的姓名反而被切碎了。
 *
 * 也不能用「逐位滑窗」—— 那会让「这周任务很多」切出「周任」
 * （周是姓，任恰好在名字用字表里）。
 *
 * 正确做法：
 *   1. 先扫出所有**姓氏锚点**的位置（复姓优先于单姓）
 *   2. 从锚点起，依次尝试 4 字、3 字、2 字，取第一个满足形态的
 *   3. 命中的话，如果后面紧跟的字符会让切分产生歧义
 *      （比如前一个字是虚词/动词，说明这里本该断开），优先断在这里
 *
 * 返回 [{ start, end, text, shape }]，按位置升序、不重叠。
 * shape: 'strict'（名字用字表命中）| 'single'（单字名）| 'loose'（仅姓氏+汉字）
 */
function findNameShaped (text) {
  const out = []
  const n = text.length
  let i = 0
  let guard = 0

  while (i < n && guard++ < 10000) {
    const ch = text[i]
    if (ch < '\u4e00' || ch > '\u9fa5') { i++; continue }

    // ---- 找姓氏锚点 ----
    let anchorAt = -1
    let anchorLen = 0
    // 复姓优先
    for (const c of COMPOUND_SURNAMES) {
      if (text.substr(i, c.length) === c) { anchorAt = i; anchorLen = c.length; break }
    }
    if (anchorAt === -1 && SURNAME_SET.has(ch)) { anchorAt = i; anchorLen = 1 }
    if (anchorAt === -1) { i++; continue }

    // ---- 从锚点起试长度 ----
    let matched = null
    for (let len = 4; len >= 2; len--) {
      const end = anchorAt + len
      if (end > n) continue
      const span = text.slice(anchorAt, end)
      // 结尾不能是虚词/动词（那是句子的下一段）
      if (len > 2 && isFunctionChar(span[span.length - 1])) continue
      if (hasNameShape(span)) { matched = { len: len, span: span, shape: 'strict' }; break }
    }
    if (!matched) {
      // 单字名
      const span = text.slice(anchorAt, anchorAt + 2)
      if (hasSingleNameShape(span)) {
        matched = { len: 2, span: span, shape: 'single' }
      }
    }

    if (matched) {
      // ---- 边界检查：姓名前一个字若是虚词/动词，说明这里本该断开 ----
      //
      // 例：「这周任务很多」—— 「周任」形态上成立（周+任，任在名字用字表里），
      // 但前面是「这」，构成「这周 | 任务」的切分，不该把「任」吃进来。
      // 而「我是王小明」前面是「是」，但那是**线索词**，不能断。
      //
      // 判据：前一个字是虚词/动词，且**不属于线索词表** → 拒绝这个切分。
      const prev = anchorAt > 0 ? text[anchorAt - 1] : ''
      const prevIsCue = CUE_BEFORE.some(function (c) {
        return text.substr(Math.max(0, anchorAt - c.length), c.length) === c
      })
      // 有些字既是虚词也是线索词（是 / 叫 / 让 / 找 / 骂…），
      // 它们前面紧跟姓氏恰恰是典型的「X是Y」「他叫Y」句式，不能断。
      const prevIsDual = DUAL_CHARS.has(prev)
      const blocked = (prev && isFunctionChar(prev) && !prevIsCue && !prevIsDual) ||
        (prev && /[0-9０-９]/.test(prev))

      if (blocked) {
        // 边界可疑 → 降级为「疑似」，不自动脱敏，但**要告警**。
        //
        // 为什么要区分「阻断」和「跳过」：
        //   「这周任务很多」          → 周任 是误切，丢弃
        //   「我们在这个王小明见过面」→ 王小明 是**真的名字**，
        //     只是切分位置可疑 —— 直接丢掉就等于漏检。
        //     所以记成疑似，交给 L3 告警让用户自己看。
        out.push({
          start: anchorAt,
          end: anchorAt + matched.len,
          text: matched.span,
          shape: matched.shape,
          uncertain: true
        })
        i = anchorAt + matched.len
        continue
      }

      out.push({
        start: anchorAt,
        end: anchorAt + matched.len,
        text: matched.span,
        shape: matched.shape
      })
      i = anchorAt + matched.len
    } else {
      i = anchorAt + 1
    }
  }
  return out
}

/**
 * 虚词/动词/方位词 —— 这些字出现在「姓名」位置时，说明那里不是名字
 */
const FUNCTION_CHARS = new Set(
  '的了是在和与或也都就还很更不没有个们这那我你他她它但把被给让从向要会能可以于上中为以而其之' +
  '所及或着过吗呢吧啊又再才只最太挺将已如若则即却比跟朝据按由至到对使叫请帮替给说讲骂吼' +
  '找问要求通知感谢恭喜同情催逼卷折磨折腾针对一二三四五六七八九十甲乙丙丁戊己庚辛壬癸' +
  '子丑寅卯辰巳午未申酉戌亥'
)

function isFunctionChar (c) {
  return FUNCTION_CHARS.has(c)
}

/**
 * 既是虚词、又是线索词的字
 *
 * 「催我的是赵磊」—— 赵前面是「是」，「是」在虚词表里，
 *   但它同时是「X是Y」句式的标志，此时**不能**断开。
 * 类似的还有：叫（他叫X）、让（X让Y）、找、骂、说…
 */
const DUAL_CHARS = new Set('是叫让找骂说讲催逼卷要求命令通知')

/**
 * 判断姓名片段附近是否有「指人线索」
 *
 * 看片段前后各若干个字符，命中线索词表即认为有线索。
 * 返回命中的线索词（用于诊断），没命中返回 null。
 */
function findCue (text, start, end, window) {
  const w = window || 8
  const before = text.slice(Math.max(0, start - w), start)
  const after = text.slice(end, Math.min(text.length, end + w))

  // 强关系词优先
  for (const r of STRONG_RELATION) {
    if (before.indexOf(r) !== -1 || after.indexOf(r) !== -1) return r
  }

  // 前置线索
  for (const c of CUE_BEFORE) {
    if (before.indexOf(c) !== -1) return c
  }
  // 后置线索
  for (const c of CUE_AFTER) {
    if (after.indexOf(c) !== -1) return c
  }
  return null
}

/**
 * 在文本中找出所有「英文姓名形态」的片段
 *
 * 覆盖：
 *   - 全小写：mr.liu / ming liu
 *   - 全大写：MR.LIU / MING LIU
 *   - 混合：Ming Liu / mIng lIU
 *   - 含连字符：Smith-Jones
 *
 * 判据：两个连续的「纯字母词」构成「名 + 姓」结构。
 *      单个词不算（那是普通名词），三个以上也不算（那是短语）。
 *
 * 为什么要两个词？因为英文里单个小写词（liu）无法与普通词区分，
 *      但「名 + 姓」的双词结构在英文里是强信号 ——
 *      "i love new york" 里的 new york 是地名，但会被误伤。
 *      所以这一层还需要上层规则配合（见 desensitize.js 的 e8/e9）。
 */
function findEnNameShaped (text) {
  const out = []
  // 连续的字母词（允许中间有空格或连字符）
  const re = /[A-Za-z]+(?:[\s-]+[A-Za-z]+){1,2}/g
  let m
  while ((m = re.exec(text)) !== null) {
    const span = m[0]
    const words = span.split(/[\s-]+/).filter(Boolean)
    if (words.length < 2) continue
    // 排除明显是短语/机构的（后面会由具体规则处理）
    out.push({ start: m.index, end: m.index + span.length, text: span, words: words })
  }
  return out
}

module.exports = {
  SURNAMES,
  COMPOUND_SURNAMES,
  NAME_CHARS,
  BLOCK_BIGRAMS,
  CUE_BEFORE,
  CUE_AFTER,
  STRONG_RELATION,
  hasNameShape,
  hasSingleNameShape,
  hasLooseNameShape,
  findNameShaped,
  findCue,
  findEnNameShaped
}
