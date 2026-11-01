/**
 * PGrefuge 脱敏引擎 · 共享实现
 *
 * 为什么抽出来：
 * 小程序端（预览降级）和论坛端（GitHub Actions 同步管道）都要用同一套规则。
 * 两边规则一旦漂移，就会出现「预览已脱敏、实际带真名」这类致命问题 ——
 * 所以规则只能有一份，两个项目共用。
 *
 * 规则与服务端 PostgreSQL 的 desensitize_detail() 完全同构：
 * 同样的规则顺序、同样的标记法、同样的命中口径。
 * 客户端与服务端的逐条一致性由 tests/desensitize-eval.js 校验（37 条样本零漂移）。
 *
 * 规则概览（8 级级联 + 4 级英文补充）：
 *   p1 泛称 + 称谓保护      「其他老师」不被拆成「某老师」
 *   p2 泛称 + 机构词保护    「今天实验室」不被拆成「某实验室」
 *   p3 「的」占位           避免姓名规则把「的」当姓氏
 *   p4 学校 / 院校 → 某校
 *   p5 学院 / 学系 → 某学院
 *   p6 课题组 / 实验室 → 某X
 *   p7 姓名 + 称谓 → 某称谓
 *   p8 「姓X」→「姓某」
 *
 *   e1 英文称谓 + 姓 → 某称谓   「Mr.Liu」→「Mr.某」
 *   e2 姓 + 英文称谓 → 某称谓   「Liu Professor」→「某 Professor」
 *   e3 姓 + 英文职衔 → 某职衔   「Liu advisor」→「某 advisor」
 *   e4 英文机构名 → 某机构       「Tsinghua University」→「某 University」
 *
 * 英文层为什么单独做：
 *   中英文混写是真实场景（很多研究生读文献、发帖都用英文）。
 *   中文规则靠「汉字 + 称谓」的结构识别，英文里没有汉字锚点，
 *   必须靠英文称谓本身（Mr./Prof./advisor）来定位，否则没法区分
 *   「Mr.Liu」（人名，该脱敏）和「Mr. Smith」（普通称呼，不该动）。
 *
 * 关键设计：捕获组内不允许出现虚词（VIRTUAL）。
 * 早期实现只在捕获组开头做一次否定断言，结果「我们在湖南大学读研」里
 * 断言只挡住「我」，捕获组照旧吃进「们在湖南」——输出成了「我某校读研」，
 * 虚词和地名一起消失。断言下沉到每个字符后才修好。
 */

/** 泛称 + 称谓（p1 保护名单） */
const GENERIC =
  '(我们|他们|其他|某位|哪位|这位|那位|这个|那个|你的|他的|她的|一位|该|各|所有|的|骂|批评|指责|催|逼|卷|折磨|折腾)'

/** 称谓（p7 目标） */
const TITLES = '(老师|导师|副教授|教授|讲师|博士|博导|系主任)'

/** 泛称 + 机构词（p2 保护名单） */
const GENERIC_ORG =
  '(今天|明天|昨天|前天|后天|上午|下午|晚上|早上|中午|最近|目前|每次|平时|每天|每周|每月|通常|经常|我们|你们|他们|这个|那个|一个|该|隔壁|附近|对面|旁边)'

/** 机构词（p4/p5/p6 目标） */
const ORGS = '(大学|学校|院校|学院|学系|课题组|实验室|科研团队|团队)'

/**
 * 虚词黑名单 —— 捕获的机构名里不允许出现这些字
 * 这份名单决定「捕获组」能吃进多少字符。
 */
const VIRTUAL =
  '(?!我|你|他|她|它|咱|们|这|那|个|是|去|回|到|达|把|被|给|跟|和|与|但|就|也|还|很|更|不|没|有|找|叫|让|对|从|向|其|之|所|及|或|在|着|过|了|吗|呢|吧|啊|又|再|才|只|最|太|挺|将|已)'

/** 捕获组：每个字符前都断言不是虚词 */
const NAME = '(?:' + VIRTUAL + '[一-龥A-Za-z0-9])'
const NAME_CN = '(?:' + VIRTUAL + '[一-龥])'

/**
 * 英文脱敏规则
 *
 * 结构上比中文简单：英文没有汉字锚点，只能靠称谓/职衔本身定位。
 * 每条规则都要求「称谓 + 至少一个看起来像姓名的词」同时出现，
 * 避免误伤普通英文（the teacher、my professor 这类不带姓名的表达）。
 */

/** 缩写式称谓（后面跟姓）：Mr.Liu / Dr. Smith / Prof. Zhang */
const EN_TITLE_DOT = '(?:Mr|Mrs|Ms|Dr|Prof|Prof\\.|Sr|Jr)'

/** 完整称谓（后面跟姓）：Professor Wang / Advisor Liu */
const EN_TITLE = '(?:Professor|Advisor|Supervisor|Teacher|Tutor|Mentor|Coordinator|Director|Head|Chair)'

/** 英文机构词 */
const EN_ORG = '(?:University|College|Institute|Laboratory|Lab|School|Academy|Polytechnic)'

/** 像英文姓名的词：首字母大写 + 至少一个字母（排除全大写缩写如 MIT） */
const EN_NAME = '[A-Z][a-z]{1,15}'

/** 像英文机构名的词组：Tsinghua / New York */
const EN_ORG_NAME = '[A-Z][a-zA-Z]{1,20}(?:\\s+[A-Z][a-zA-Z]{1,20}){0,2}'

// 与服务端 chr() 标记同构（用 String.fromCharCode，避免源码里出现控制字符）
const M1 = String.fromCharCode(1) // 泛称保护
const M2 = String.fromCharCode(2) // 替换结果包裹
const M3 = String.fromCharCode(3) // 「的」占位
const M4 = String.fromCharCode(4) // 泛称 + 机构词保护

/**
 * 敏感信息类型的展示文案
 *
 * 双语：命中标签跟随「被脱敏内容的语言」。
 * 用户写英文帖就看到英文标签，写中文帖看到中文标签，
 * 中英混排时各条命中各自跟随。
 */
const HIT_LABELS = {
  school: '学校名称',
  college: '学院 / 学系',
  team: '课题组 / 实验室',
  person: '姓名 + 称谓',
  surname: '姓氏',
  personEn: '英文姓名',
  orgEn: '英文机构名'
}

/** 英文版标签 */
const HIT_LABELS_EN = {
  school: 'School name',
  college: 'College / Department',
  team: 'Lab / Research team',
  person: 'Name + Title',
  surname: 'Surname',
  personEn: 'English name',
  orgEn: 'English organization'
}

/**
 * 占位符表
 *
 * 关键设计：占位符的语言跟随「被脱敏内容」的语言，而不是整篇文本。
 *
 * 为什么不按整篇文本判定：
 *   「我在 Tsinghua University 读研，导师姓李」这种中英混排很常见。
 *   若按整篇判定，英文校名会被替换成中文占位符，读起来别扭。
 *   按规则命中来定 —— 中文规则（p4~p8）命中的就是中文内容，
 *   英文规则（e1~e5）命中的就是英文内容 —— 各自自然。
 *
 * 英文占位符用 ___ 和 Someone：
 *   ___ 保留原机构词（___ University / ___ Lab），语义清楚；
 *   Someone 是英文里通行的匿名代称（Mr. Someone）。
 *   比中文「某」硬译成 "certain" 自然得多。
 */
const MASK_CN = {
  school: '某校',
  college: '某学院',
  team: '某',
  person: '某',
  surname: '姓某',
  personEn: '某',
  orgEn: '某'
}

const MASK_EN = {
  school: '___',
  college: '___',
  team: '___',
  person: 'Someone',
  surname: '___',
  personEn: 'Someone',
  orgEn: '___'
}

/** 判定一段文本的主体语言：'cn' / 'en' */
function detectLang(text) {
  const cn = (String(text).match(/[一-龥]/g) || []).length
  const en = (String(text).match(/[A-Za-z]/g) || []).length
  return cn >= en ? 'cn' : 'en'
}

/**
 * 脱敏
 * @param {string} text 原始内容
 * @returns {{content: string, changed: boolean, hits: Array<{kind: string, count: number}>}}
 */
function desensitize(text) {
  const src = text || ''
  const hits = []
  let out = src

  // p1 泛称 + 称谓保护
  out = out.replace(new RegExp(GENERIC + TITLES, 'g'), '$1' + M1 + '$2')
  // p2 泛称 + 机构词保护
  out = out.replace(new RegExp(GENERIC_ORG + ORGS, 'g'), '$1' + M4 + '$2' + M4)
  // p3 「的」占位
  out = out.replace(/的/g, M3)

  // 替换并统计命中数
  // 注意：使用 callback 时替换串里的 $1/$2 不会被解析，必须手动取捕获组
  //
  // lang 参数指定该规则产出哪种语言的占位符：
  //   'cn' → 某校 / 某实验室 / 某老师 / 姓某
  //   'en' → Mr. Someone / ___ University / ___ Lab
  // 中英混排时各条命中各自跟随，不会出现「英文句子里夹中文占位符」。
  const step = (re, kind, build, lang) => {
    let n = 0
    out = out.replace(re, function () {
      n++
      return build.apply(null, arguments)
    })
    if (n > 0) hits.push({ kind, count: n, lang: lang || 'cn' })
  }

  // p4 学校 / 院校 → 某校
  step(new RegExp('(' + NAME_CN + '{1,8})(大学|学校|院校)', 'g'), 'school',
    () => M2 + MASK_CN.school + M2, 'cn')
  // p5 学院 / 学系 → 某学院
  step(new RegExp('(' + NAME_CN + '{1,8})(学院|学系)', 'g'), 'college',
    () => M2 + MASK_CN.college + M2, 'cn')
  // p6 课题组 / 实验室 → 某X
  //    捕获组允许英文（NAME 含 A-Za-z），所以「Tsinghua Lab」也会命中 ——
  //    但英文机构由 e5 规则接手并给出英文占位符，这里按捕获组实际语言决定。
  step(new RegExp('(' + NAME + '{1,12})(课题组|实验室|科研团队|团队)', 'g'), 'team',
    (m, g1, g2) => {
      const en = detectLang(g1) === 'en'
      const mask = en ? MASK_EN.team : MASK_CN.team
      return M2 + mask + g2 + M2
    }, 'auto')
  // p7 姓名 + 称谓 → 某称谓
  step(new RegExp('(' + NAME_CN + '{1,2}?)' + TITLES, 'g'), 'person',
    (m, g1, g2) => M2 + MASK_CN.person + g2 + M2, 'cn')
  // p8 「姓X」→「姓某」
  step(/姓([一-龥]{1,2})/g, 'surname', () => M2 + MASK_CN.surname + M2, 'cn')

  // ---- 英文补充规则 ----
  //
  // 放在中文规则之后：中文规则会把「的」换成 M3，英文规则不受影响；
  // 反过来则可能被中文规则吃掉英文边界，所以这个顺序不能反。
  //
  // 英文的语序和中文相反 —— 英文是「称谓 + 姓」（Professor Wang），
  // 中文是「姓 + 称谓」（王教授）。两种都覆盖，但主规则必须是「称谓 + 姓」。

  // e1 缩写称谓 + 姓：Mr.Liu → Mr. Someone
  //    要求点号紧跟姓，或称谓与姓之间有空格（两种写法都覆盖）
  step(
    new RegExp('\\b(' + EN_TITLE_DOT + ')\\.?\\s*(' + EN_NAME + ')\\b', 'g'),
    'personEn',
    (m, g1, g2) => M2 + g1 + '. ' + MASK_EN.personEn + M2,
    'en'
  )
  // e2 完整称谓 + 姓：Professor Wang → Professor Someone
  //    这是英文最常见的写法，必须有「姓」跟在后面才动手，
  //    否则 "my professor was not there" 这类会被误伤。
  step(
    new RegExp('\\b(' + EN_TITLE + ')\\s+(' + EN_NAME + ')\\b', 'g'),
    'personEn',
    (m, g1, g2) => M2 + g1 + ' ' + MASK_EN.personEn + M2,
    'en'
  )
  // e3 小写职衔 + 姓：advisor Liu → advisor Someone
  //    小写职衔单独成词时容易误伤，这里要求后面跟一个像姓名的首字母大写词
  step(
    new RegExp('\\b(advisor|supervisor|mentor|tutor)\\s+(' + EN_NAME + ')\\b', 'g'),
    'personEn',
    (m, g1, g2) => M2 + g1 + ' ' + MASK_EN.personEn + M2,
    'en'
  )
  // e4 姓 + 完整称谓：Wang Professor → Someone Professor
  //    中式英文或简历写法里会出现，补上。
  step(
    new RegExp('\\b(' + EN_NAME + ')\\s+(' + EN_TITLE + ')\\b', 'g'),
    'personEn',
    (m, g1, g2) => M2 + MASK_EN.personEn + ' ' + g2 + M2,
    'en'
  )
  // e5 英文机构名：Tsinghua University → ___ University
  step(
    new RegExp('\\b(' + EN_ORG_NAME + ')\\s+(' + EN_ORG + ')\\b', 'g'),
    'orgEn',
    (m, g1, g2) => M2 + MASK_EN.orgEn + ' ' + g2 + M2,
    'en'
  )

  // 还原「的」，去掉所有标记
  out = out.split(M3).join('的').split(M2).join('').split(M1).join('').split(M4).join('')

  return { content: out, changed: out !== src, hits }
}

/**
 * 把 hits 汇总成「学校名称、姓名 + 称谓」这样的标签列表
 *
 * 标签语言跟随该条命中的语言（hits[].lang）：
 * 英文帖命中 → "School name"；中文帖命中 → 「学校名称」。
 * 中英混排时每条各自跟随。
 */
function summarize(hits) {
  const kinds = []
  ;(hits || []).forEach((h) => {
    const key = h.kind + '|' + (h.lang || 'cn')
    if (kinds.indexOf(key) === -1) kinds.push(key)
  })
  return kinds.map((key) => {
    const parts = key.split('|')
    const table = parts[1] === 'en' ? HIT_LABELS_EN : HIT_LABELS
    return table[parts[0]] || parts[0]
  })
}

/**
 * 导出
 *
 * 同时支持 CommonJS（Node：同步管道、评测脚本）和浏览器全局
 * （站点页面的「发帖前预览」直接在本地跑脱敏，不发任何网络请求）。
 * 同一份源码两种形态 —— 规则不可能漂移。
 */
const API = {
  desensitize,
  summarize,
  HIT_LABELS,
  // 导出常量，供评测脚本复用同一份定义
  GENERIC,
  TITLES,
  GENERIC_ORG,
  ORGS,
  VIRTUAL
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API
}
if (typeof window !== 'undefined') {
  window.PGDesensitize = API
}
