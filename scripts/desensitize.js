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
 * 名称与机构词/称谓之间的分隔符
 *
 * 为什么需要：「李 老师」「李-老师」「星洲大学-自动化学院」
 * 这类写法在真实场景里很常见 —— 尤其是从聊天记录、PDF、邮件里复制粘贴的内容。
 * 原来的规则要求名称与后缀紧邻，遇到分隔符就漏检。
 *
 * 关键约束（三条都踩过）：
 *   1. **不含汉字** —— 否则贪婪匹配会把称谓本身吃进分隔符组，
 *      「李（老师）」会变成「某（）」，称谓丢了反而更糟。
 *   2. **不含圆括号** —— 括号在中文里是「包住」后缀的，不是夹在中间的。
 *      把 `（）` 放进分隔符会让正则把左括号当分隔符吃掉，
 *      机构词匹配错位（捕获到「（」而不是「实验室」）。
 *      括号由下面的 BRACKET 单独处理。
 *   3. **不含逗号句号等句子分隔符** —— 「读研，导师」会被当成
 *      「姓名，导师」整段匹配，把「读研」脱敏成「某」。
 *      名称和称谓之间只可能有空白、连字符这类连接符，
 *      不可能有句读。
 *
 * 用**命名捕获组**（?<sep>）而不是普通捕获组：
 *   命名组仍占编号（只有 (?:) 才是纯不捕获），
 *   但取值按名字来，不受其他可选组增减的影响。
 */
const SEP =
  '(?<sep>(?:(?![一-龥])[\\s\\-–—_·・' +
  '－~～/\\\\])*?)'

/**
 * 可选的成对括号（包住后缀）
 *
 * 「结构力学（实验室）」「李（老师）」「李[老师]」
 * —— 括号在中文书写习惯里是**包住**后缀的。
 *
 * 实现要点（三个坑都踩过）：
 *
 * 1. **左右括号必须成对**。如果拆成两个独立可选组，
 *    正则会在捕获组后停下，右括号落在匹配之外成了孤儿 ——
 *    输出变成「我在某实验室）通宵」。
 *
 * 2. **方括号用 Unicode 转义**（`[`, `]`），
 *    不直接写字面量。
 *    之前写过 `[)）\]...]`，JS 字符串里的 `\]` 不是有效转义序列
 *    （反斜杠被丢弃），字符类提前闭合，右括号永远匹配不上。
 *    后来试「首位写法」`[]()...]`，两个连续方括号又让解析器
 *    报 Unterminated group。
 *    用 `\u005B` / `\u005D` 是最稳的 —— 转义序列本身没有歧义。
 *
 * 3. 括号内的空白不进捕获组，否则会把后缀顶掉。
 */
const BRACKET_OPEN = '(?:[\\u005B\\u0028\\uFF08\\u3010\\u300A\\u3008\\u300C\\u300E]\\s*)?'
const BRACKET_CLOSE = '(?:[\\u005D\\u0029\\uFF09\\u3011\\u300B\\u3009\\u300D\\u300F])?'

/**
 * 英文脱敏规则
 *
 * 结构上比中文简单：英文没有汉字锚点，只能靠称谓/职衔本身定位。
 * 每条规则都要求「称谓 + 至少一个看起来像姓名的词」同时出现，
 * 避免误伤普通英文（the teacher、my professor 这类不带姓名的表达）。
 */

/**
 * 生成英文词的大小写变体正则
 *
 * 为什么需要：英文的称谓可能被写成任意大小写。
 *   Professor / PROFESSOR / Mr. / MR. 都见过。
 *   手写 `[Pp]rofessor` 这种只能覆盖首字母变体，覆盖不了全大写。
 *   用代码生成「首字母大写 | 全大写」两种形态，不会漏、也不会写错。
 *
 * 小写形态（professor）刻意不覆盖 ——
 *   小写称谓在英文里通常是不带姓名的泛称（my professor was absent），
 *   把它当姓名会误伤。
 *
 * 纯大写词（II / III / IV 这类罗马数字）只保留大写形态 ——
 *   首字母大写化会把 II 变成 Ii，那是另一个词，会造成误匹配。
 */
function enVariants(words) {
  return words
    .map(function (w) {
      const upper = w.toUpperCase()
      // 全大写词（罗马数字、缩写）不再生成首字母大写变体
      if (w === upper) return upper
      const cap = w[0].toUpperCase() + w.slice(1).toLowerCase()
      return cap === upper ? cap : cap + '|' + upper
    })
    .join('|')
}

/** 缩写式称谓（后面跟姓）：Mr.Liu / MR.LIU / Dr. Smith */
const EN_TITLE_DOT = '(?:' + enVariants(['Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sr', 'Jr']) + ')'

/** 完整称谓（后面跟姓）：Professor Wang / PROFESSOR WANG / Advisor Liu */
const EN_TITLE = '(?:' + enVariants([
  'Professor', 'Advisor', 'Supervisor', 'Teacher', 'Tutor',
  'Mentor', 'Coordinator', 'Director', 'Head', 'Chair'
]) + ')'

/** 小写职衔（后面跟姓）：advisor Liu / advisor LIU */
const EN_TITLE_LOWER = '(?:advisor|supervisor|mentor|tutor)'

/** 英文机构词（支持全大写：TSINGHUA UNIVERSITY） */
const EN_ORG = '(?:' + enVariants([
  'University', 'College', 'Institute', 'Laboratory', 'Lab',
  'School', 'Academy', 'Polytechnic'
]) + ')'

/**
 * 像英文姓名的词
 *
 * 两种形态，用途不同：
 *
 *   EN_NAME_STRICT —— 首字母大写 + 小写（Liu / Smith）
 *     用于「纯姓形态」的识别。必须是这个形态，否则
 *     "Liu is my advisor" 里的 Liu 和 "NASA" 无法区分。
 *
 *   EN_NAME_ANY —— 首字母大写 + 任意大小写字母（Liu / LIU）
 *     用于「有称谓锚点」的识别。前面已经限定了 Mr./Prof./advisor，
 *     上下文已经提供了足够强的信号，这时大小写不该再成为漏检的理由 ——
 *     用户手打、输入法联想、全大写强调都可能导致 LIU 这种写法。
 *
 * 边界：至少 2 个字母，避免把单字母缩写误当姓名。
 */
const EN_NAME_STRICT = '[A-Z][a-z]{1,15}'
const EN_NAME_ANY = '[A-Z][A-Za-z]{1,15}'

/**
 * 姓的可选后缀与连字符部分
 *
 * Smith-Jones  →  两段都要脱敏，不能只换前半段（那会留下真名 Jones）
 * Liu Jr.      →  后缀保留
 *
 * 两个坑（都踩过）：
 *
 * 1. 后缀里的罗马数字（II/III/IV）会和姓名里的字母冲突 ——
 *    "LIU" 里的 I 能被当成 IV 的开头，结果输出成 "Someone3"。
 *    修法：后缀前加负向断言，要求它前面是**非字母**。
 *    这样 "LIU" 不会被误读成 "L" + "IU" 后缀。
 *
 * 2. 后缀组必须用**命名捕获组**（?<sfx>）——
 *    之前用普通捕获组时，正则里其他可选组的存在与否会改变捕获组编号，
 *    build 函数拿到的第 3 个参数就成了 replace 回调的 **offset（数字）**，
 *    于是输出成 "Someone3" 这种鬼样子。
 *    命名捕获组按名字取，不受编号漂移影响。
 */
const EN_NAME_PART =
  EN_NAME_ANY + '(?:\\s*-\\s*' + EN_NAME_ANY + ')?'
const EN_NAME_SUFFIX =
  '(?:(?<![A-Za-z])\\s+(?<sfx>' + enVariants(['Jr', 'Sr', 'II', 'III', 'IV']) + ')\\.?)?'

/** 像英文机构名的词组：Tsinghua / New York / TSINGHUA */
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

/**
 * 清掉没有配对左括号的闭合符号
 *
 * 替换后可能出现「某校（某学院」这种括号不配对的残留。
 * 做法：逐个字符扫描，维护一个左括号栈；
 * 遇到闭合符号时，栈为空说明没有配对的左括号，删掉它。
 */
function removeOrphanClosers(text) {
  const OPEN = '（(【《〈「『\u005B'
  const CLOSE = '）)】》〉」』\u005D'
  const stack = []
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (OPEN.indexOf(c) !== -1) {
      stack.push(i) // 记录左括号在 out 里的位置
      out += c
    } else if (CLOSE.indexOf(c) !== -1) {
      if (stack.length) {
        stack.pop()
        out += c
      }
      // 栈为空 → 孤立的闭合符号，直接丢弃
    } else {
      out += c
    }
  }
  // 栈里剩下的左括号都没有配对的右括号，也一并删掉
  // （删除要从后往前，否则下标会错位）
  let positions = stack.slice().sort(function (a, b) { return b - a })
  for (const pos of positions) {
    out = out.slice(0, pos) + out.slice(pos + 1)
  }
  return out
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
      // 命名捕获组在最后一个参数（groups 对象）里。
      // 用它取分隔符/后缀，避免依赖捕获组的编号 ——
      // 正则里可选组的多寡会改变编号，位置参数会漂移。
      // （曾经因为这个，build 收到的第 3 个参数其实是 replace 的 offset，
      //   输出成了 "Someone3"。）
      const args = Array.prototype.slice.call(arguments)
      const groups = args[args.length - 1]
      const g = (groups && typeof groups === 'object') ? groups : {}
      // 命名捕获组（?<name>）**仍然占编号** —— 只有 (?:) 才是纯不捕获。
      // 所以带命名组的正则里，位置参数的编号会整体后移。
      // 因此这里统一用命名组取值，位置参数只当兜底，
      // 避免「改一个可选组就错位」的坑。
      const sep = g.sep !== undefined ? g.sep : ''
      const sfx = g.sfx !== undefined ? g.sfx : ''
      return build.call(this, args[0], args[1], args[2], args[3], sep, sfx)
    })
    if (n > 0) hits.push({ kind, count: n, lang: lang || 'cn' })
  }

  // p4 学校 / 院校 → 某校
  step(new RegExp('(' + NAME_CN + '{1,8})' + SEP + BRACKET_OPEN + '(大学|学校|院校)' + BRACKET_CLOSE, 'g'), 'school',
    function (m, g1, g2, g3, sep) { return M2 + MASK_CN.school + (sep || '') + M2 }, 'cn')
  // p5 学院 / 学系 → 某学院
  step(new RegExp('(' + NAME_CN + '{1,8})' + SEP + BRACKET_OPEN + '(学院|学系)' + BRACKET_CLOSE, 'g'), 'college',
    function (m, g1, g2, g3, sep) { return M2 + MASK_CN.college + (sep || '') + M2 }, 'cn')
  // p6 课题组 / 实验室 → 某X
  //    捕获组允许英文（NAME 含 A-Za-z），所以「Tsinghua Lab」也会命中 ——
  //    但英文机构由 e5 规则接手并给出英文占位符，这里按捕获组实际语言决定。
  step(new RegExp('(' + NAME + '{1,12})' + SEP + BRACKET_OPEN + '(课题组|实验室|科研团队|团队)' + BRACKET_CLOSE, 'g'), 'team',
    function (m, g1, g2, g3, sep) {
      const en = detectLang(g1) === 'en'
      const mask = en ? MASK_EN.team : MASK_CN.team
      // 「结构力学（实验室）」→ 机构词被移到前面后，原来包裹它的括号会变成空壳。
      // 纯标点/括号的分隔符整段丢掉（连左括号带右括号一起），
      // 只保留含有实际内容的分隔符（如「星洲大学-自动化学院」里的连字符）。
      const s = sep || ''
      const keepSep = /[\u4e00-\u9fa5A-Za-z0-9]/.test(s) ? s : ''
      return M2 + mask + (g3 || '') + keepSep + M2
    }, 'auto')
  // p7 姓名 + 称谓 → 某称谓
  //    姓名与称谓之间允许插入分隔符 —— 「李（老师）」「李 老师」「李-老师」
  //    这类写法很常见，尤其是从聊天记录或 PDF 里复制出来的。
  step(new RegExp('(' + NAME_CN + '{1,2}?)' + SEP + BRACKET_OPEN + '(' + TITLES + ')' + BRACKET_CLOSE, 'g'), 'person',
    function (m, g1, g2, g3, sep) { return M2 + MASK_CN.person + (sep || '') + (g3 || '') + M2 }, 'cn')
  // p8 「姓X」→「姓某」
  step(/姓([一-龥]{1,2})/g, 'surname', () => M2 + MASK_CN.surname + M2, 'cn')

  // ---- 英文补充规则 ----
  //
  // 放在中文规则之后：中文规则会把「的」换成 M3，英文规则不受影响；
  // 反过来则可能被中文规则吃掉英文边界，所以这个顺序不能反。
  //
  // 英文的语序和中文相反 —— 英文是「称谓 + 姓」（Professor Wang），
  // 中文是「姓 + 称谓」（王教授）。两种都覆盖，但主规则必须是「称谓 + 姓」。

  // e1 完整称谓 + 姓：Professor Wang / PROFESSOR WANG → Professor Someone
  //    必须排在 e2（缩写称谓）之前 —— 否则 "PROFESSOR" 会被 "PROF" 抢先匹配，
  //    把 ESSOR 当成姓吃掉，输出成 "PROF. Someone"。
  //    称谓后面要求不紧跟字母（(?![A-Za-z])），防止这种拆分。
  step(
    new RegExp('\\b(' + EN_TITLE + ')(?![A-Za-z])\\s+(' + EN_NAME_PART + ')' + EN_NAME_SUFFIX, 'g'),
    'personEn',
    function (m, g1, g2, g3, sep, sfx) { return M2 + g1 + ' ' + MASK_EN.personEn + (sfx || '') },
    'en'
  )
  // e2 缩写称谓 + 姓：Mr.Liu / Mr.LIU / Mr.Liu Jr. → Mr. Someone
  //    点号可有可无，空格可有可无（\s* 覆盖多空格）。
  //    姓用宽松模式 —— 前面有称谓锚点，大小写不该成为漏检的理由。
  //    称谓后面要求**不紧跟字母**（(?![A-Za-z])）——
  //    否则 "PROFESSOR WANG" 会被 "PROF" 抢先匹配，把 ESSOR 当成姓。
  step(
    new RegExp('\\b(' + EN_TITLE_DOT + ')(?![A-Za-z])\\.?\\s*(' + EN_NAME_PART + ')' + EN_NAME_SUFFIX, 'g'),
    'personEn',
    function (m, g1, g2, g3, sep, sfx) { return M2 + g1 + '. ' + MASK_EN.personEn + (sfx || '') },
    'en'
  )
  // e3 小写职衔 + 姓：advisor Liu / advisor LIU → advisor Someone
  //    小写职衔单独成词时容易误伤，这里要求后面跟一个像姓名的首字母大写词
  step(
    new RegExp('\\b(' + EN_TITLE_LOWER + ')\\s+(' + EN_NAME_PART + ')' + EN_NAME_SUFFIX, 'g'),
    'personEn',
    function (m, g1, g2, g3, sep, sfx) { return M2 + g1 + ' ' + MASK_EN.personEn + (sfx || '') },
    'en'
  )
  // e4 姓 + 完整称谓：Wang Professor / WANG Professor → Someone Professor
  //    中式英文或简历写法里会出现，补上。
  //    姓用严格模式：这一条前面没有称谓锚点，全大写时无法与普通词区分。
  step(
    new RegExp('\\b(' + EN_NAME_STRICT + ')\\s+(' + EN_TITLE + ')\\b', 'g'),
    'personEn',
    (m, g1, g2) => M2 + MASK_EN.personEn + ' ' + g2 + M2,
    'en'
  )
  // e5 英文机构名：Tsinghua University / TSINGHUA UNIVERSITY → ___ University
  //    机构词本身也要能匹配全大写（UNIVERSITY）。
  step(
    new RegExp('\\b(' + EN_ORG_NAME + ')\\s+(' + EN_ORG + ')\\b', 'g'),
    'orgEn',
    (m, g1, g2) => M2 + MASK_EN.orgEn + ' ' + g2 + M2,
    'en'
  )
  // e6 纯姓形态（上下文锚定）：Liu is my advisor / Liu, my advisor
  //    没有称谓锚点时，靠「姓 + 关系词」这个句式来识别。
  //    姓必须用严格模式（首字母大写+小写）——
  //    否则 "I work at NASA" 这类会被误伤。
  //
  //    语序要点：英文的姓通常在句首（Liu is my advisor），
  //    不是中文那种「我姓李」。所以锚点放在姓后面。
  step(
    new RegExp('\\b(' + EN_NAME_STRICT + ')(?![A-Za-z])\\s+(?:is|was|are|were)\\s+(?:my|our|his|her|their)\\b', 'g'),
    'personEn',
    function (m, g1) { return M2 + MASK_EN.personEn + M2 },
    'en'
  )
  // e7 关系词 + 姓（另一种语序）：my advisor Liu / her supervisor Wang
  //    前面已有关系词提供锚点，姓用宽松模式以覆盖全大写。
  step(
    new RegExp('\\b(?:my|our|his|her|their)\\s+(' + EN_TITLE_LOWER + ')\\s+(' + EN_NAME_PART + ')', 'g'),
    'personEn',
    function (m, g1, g2) { return M2 + g1 + ' ' + MASK_EN.personEn + M2 },
    'en'
  )

  // 还原「的」，去掉所有标记
  out = out.split(M3).join('的').split(M2).join('').split(M1).join('').split(M4).join('')

  // 清理孤立的闭合括号
  //
  // 嵌套括号场景：「星洲大学（自动化学院）」
  //   p4 先替换「星洲大学」→「某校」，左括号留了下来；
  //   p5 再替换「自动化学院」→「某学院」，右括号留了下来。
  //   结果是「某校（某学院」—— 括号不配对，读起来很奇怪。
  //
  // 这里扫描一遍，把没有配对左括号的闭合符号去掉。
  out = removeOrphanClosers(out)

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
