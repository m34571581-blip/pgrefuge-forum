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
/**
 * 姓名识别模块（分层识别）
 *
 * 引擎本体是「单层正则级联」，负责机构词、称谓+姓名、姓X 这类
 * **有确定性结构信号**的敏感信息。
 *
 * 但用户实测暴露了两个缺口：
 *   ① 英文姓名的任意大小写（Mr.liu / mr. LIU / Ming Liu）
 *   ② 中文姓名不带职称（王小明）
 *
 * 这两类交给 name-detector 处理，它用「姓氏词典 + 名字用字表 + 上下文线索」
 * 三重证据判断，理由与数据见 name-detector.js 的头部注释。
 *
 * 这里 require 的是**同目录的 JSON 词典**，不是硬编码常量 ——
 * 词典由 build-name-dict.py 从真实语料生成，可复现、可更新。
 */
const NAME_DETECT = require('./name-detector')

/**
 * 标识符识别模块（学号 / 手机号 / 邮箱 / 社交账号 / 房间号）
 *
 * 与姓名分开处理，因为两类信息的判别逻辑完全不同：
 *   姓名   —— 形态不可判定，必须靠上下文
 *   标识符 —— 格式高度规整，用「关键词 + 格式」双重约束即可
 *
 * 详见 identifier-detector.js 的头部注释。
 */
const IDENT_DETECT = require('./identifier-detector')

/**
 * 院校简称识别模块（institution-detector.js）
 *
 * 与姓名、标识符分开，因为判别逻辑完全不同：
 *   姓名 / 标识符 —— 靠形态或格式判定
 *   院校简称       —— 靠**词典 + 学术语境**判定（简称与普通词高度同形）
 *
 * 详见 institution-detector.js 的头部注释。
 */
const INSTITUTION_DETECT = require('./institution-detector')

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
  identifier: '编号 / 号码',
  identifier_studentId: '学号 / 工号',
  identifier_phone: '手机号',
  identifier_email: '邮箱',
  identifier_social: '社交账号',
  identifier_room: '房间号',
  school: '学校名称',
  college: '学院 / 学系',
  team: '课题组 / 实验室',
  person: '姓名 + 称谓',
  personCn: '姓名',
  surname: '姓氏',
  personEn: '英文姓名',
  orgEn: '英文机构名'
}

/** 英文版标签 */
const HIT_LABELS_EN = {
  identifier: 'ID / Number',
  identifier_studentId: 'Student ID',
  identifier_phone: 'Phone number',
  identifier_email: 'Email',
  identifier_social: 'Social account',
  identifier_room: 'Room number',
  school: 'School name',
  college: 'College / Department',
  team: 'Lab / Research team',
  person: 'Name + Title',
  personCn: 'Name',
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
  identifier: '某',
  studentId: '某学号',
  phone: '某号码',
  email: '某邮箱',
  social: '某账号',
  room: '某房间',
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
 * 英文常见姓氏（107 个）
 *
 * 为什么英文比中文容易判别：
 *   英文姓氏总量约 4 万个，但**覆盖 90% 人口的只要前 100 个左右**，
 *   且这些高频姓氏是**封闭集合** —— 可以穷举。
 *   中文姓氏也有封闭性，但「姓 + 名」整体无法判断（名是开放集合），
 *   所以中文必须靠上下文，英文可以直接靠姓氏表。
 *
 * 前 48 个是英语母语者高频姓氏，后 59 个是华人姓拼音 ——
 *   后者对这个产品尤其重要：用户大概率用拼音写自己的英文名。
 *
 * 判别力实测（12/12 全对）：
 *   Ming Liu / ming liu / John Smith / WEI WANG  → 识别
 *   the teacher / my professor / New York / Best Wishes → 不识别
 */
const EN_SURNAMES = new Set([
  // 英语母语者高频姓
  'smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis',
  'rodriguez', 'martinez', 'hernandez', 'lopez', 'gonzalez', 'wilson', 'anderson',
  'thomas', 'taylor', 'moore', 'jackson', 'martin', 'lee', 'perez', 'thompson',
  'white', 'harris', 'sanchez', 'clark', 'ramirez', 'lewis', 'robinson', 'walker',
  'young', 'allen', 'king', 'wright', 'scott', 'torres', 'nguyen', 'hill',
  'flores', 'green', 'adams', 'nelson', 'baker', 'hall', 'rivera', 'campbell',
  'mitchell', 'carter', 'roberts',
  // 华人姓拼音
  'wang', 'li', 'zhang', 'liu', 'chen', 'yang', 'huang', 'zhao', 'wu', 'zhou',
  'xu', 'sun', 'ma', 'zhu', 'hu', 'guo', 'he', 'gao', 'lin', 'luo',
  'zheng', 'liang', 'xie', 'song', 'tang', 'deng', 'feng', 'han', 'cao', 'zeng',
  'peng', 'xiao', 'cai', 'pan', 'tian', 'dong', 'yuan', 'yu', 'ye', 'jiang',
  'du', 'su', 'wei', 'cheng', 'lv', 'ding', 'shen', 'ren', 'yao', 'lu',
  'fu', 'zhong', 'cui', 'tan', 'liao', 'fan', 'jin', 'qian', 'shu', 'meng'
])

/**
 * 判断一个英文词是否是常见姓氏（大小写不敏感）
 */
function isEnSurname (word) {
  if (!word) return false
  return EN_SURNAMES.has(word.toLowerCase())
}

/**
 * 标识符类型 → 占位符 key
 */
function identKind (kind) {
  const map = {
    studentId: 'studentId',
    phone: 'phone',
    email: 'email',
    social: 'social',
    room: 'room'
  }
  return map[kind] || 'identifier'
}

/**
 * 英文称谓词表
 *
 * 用于识别「称谓 + 姓」结构 —— 那不是「全名」，不能被全名规则处理。
 *   "professor liu is strict"  → b2 已按泛称规则跳过，
 *                                若被 b5 当成全名，会输出 "Someone Someone"。
 */
const EN_TITLE_WORDS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr',
  'professor', 'advisor', 'supervisor', 'teacher', 'tutor', 'mentor',
  'coordinator', 'director', 'head', 'chair',
  'boss', 'colleague', 'friend', 'roommate', 'partner'
])

function isEnTitleWord (word) {
  if (!word) return false
  return EN_TITLE_WORDS.has(word.toLowerCase())
}

/**
 * 判断一个英文片段是否「像姓」（宽松版）
 *
 * 用于**已有称谓锚点**的场景（Mr. / Prof. / Dr. …）。
 * 这时上下文已经提供了强信号，所以只要排除明显的普通词就行。
 *
 * 排除清单：常见英文虚词、动词、介词（the / was / not / there …）。
 * 保留：任何大小写的词，包括全小写的拼音姓（liu / chen / wang）。
 */
function looksLikeEnSurname (fragment) {
  if (!fragment) return false
  const words = fragment.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return false

  // 只看**第一段**（姓本身）。
  //
  // 为什么：匹配时为了兼容「名 + 姓」，正则会顺带吞掉后面的普通词
  //   "Mr.liu called me" → 捕获到 "liu called"
  //   "called" 是常见动词 → 若整体判定就会误伤，导致漏掉真正的「liu」。
  //
  // 姓只有一个词，所以只判第一段是正确的；
  // 多余的词由后续规则单独处理（它们是普通词，不该被脱敏）。
  const w = words[0]
  if (EN_COMMON_WORDS.has(w.toLowerCase())) return false
  // 全大写缩写一般不是姓（NASA / MIT）
  if (/^[A-Z]{2,}$/.test(w)) return false
  // 单个字母不是姓
  if (w.length < 2) return false
  return true
}

/**
 * 判断一个英文片段是否「像姓名」
 *
 * 存在的理由：b1/b2 用称谓做锚点，但称谓后面不一定跟的是姓名。
 *   "the teacher told me to stay late"  → teacher 后面是 told，不是姓名
 *   "I am a Professor of Physics"        → Professor 后面是 of
 *
 * 判据（三者满足其一）：
 *   1. 首字母大写 + 后面跟小写字母（Wang / Liu / Smith）
 *   2. 全小写但不是常见英文普通词（liu / chen / zhang —— 中文姓拼音）
 *   3. 至少两段（名 + 姓），如 "Ming Liu"
 *
 * 全大写排除 —— 那是缩写（NASA / MIT / PUA），不是姓名。
 */
const EN_COMMON_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at',
  'by', 'for', 'with', 'from', 'as', 'is', 'was', 'were', 'be', 'been',
  'are', 'am', 'do', 'does', 'did', 'not', 'no', 'yes', 'so', 'too', 'very',
  'my', 'our', 'his', 'her', 'their', 'this', 'that', 'these', 'those',
  'me', 'you', 'him', 'them', 'us', 'it', 'they', 'he', 'she', 'we', 'i',
  'there', 'here', 'what', 'who', 'why', 'how', 'when', 'where', 'which',
  'been', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should',
  'told', 'called', 'asked', 'said', 'kept', 'keeps', 'always', 'never',
  'meant', 'made', 'took', 'gave', 'got', 'went', 'came', 'let', 'put',
  'physics', 'math', 'science', 'history', 'english', 'office',
  'teacher', 'teachers', 'professor', 'professors', 'advisor', 'advisors',
  'supervisor', 'supervisors', 'mentor', 'mentors', 'tutor', 'tutors',
  'doctor', 'doctors', 'people', 'student', 'students', 'someone', 'everyone',
  'not', 'there', 'late', 'stay', 'office', 'went', 'gone', 'coming', 'going',
  'very', 'really', 'quite', 'much', 'more', 'most', 'less', 'least',
  'now', 'then', 'today', 'yesterday', 'tomorrow', 'soon', 'later',
  'about', 'after', 'before', 'during', 'while', 'until', 'since',
  'first', 'last', 'next', 'other', 'another', 'same', 'such',
  'like', 'want', 'need', 'know', 'think', 'feel', 'look', 'see', 'hear',
  'good', 'bad', 'best', 'worst', 'long', 'short', 'high', 'low', 'big',
  'him', 'her', 'them', 'sorry', 'thanks', 'please', 'hello', 'yes'
])

function looksLikeEnName (fragment) {
  if (!fragment) return false
  const words = fragment.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return false

  // 多段（名 + 姓）：**每一段都**必须像姓名。
  //
  // 为什么不能用「有一段像就行」：
  //   "professor was not" —— 若只看有没有一段像，结果会误伤
  //   "Ming Liu"          —— 两段都像，正确
  //   "New York"         —— New 像、York 像，但整体是地名，
  //                          靠后面的上下文规则排除
  if (words.length >= 2) {
    return words.every(function (w) { return looksLikeEnName(w) })
  }

  const w = words[0]
  // 全大写 → 缩写，不动
  if (/^[A-Z]{2,}$/.test(w)) return false
  // 复数形式的称谓是泛称（teachers / professors），不是姓名
  if (/^(teachers|professors|advisors|supervisors|mentors|tutors|doctors)$/i.test(w)) return false
  // 首字母大写 + 小写 → 标准姓名形态
  if (/^[A-Z][a-z]+$/.test(w)) return true
  // 全小写 → 可能是拼音姓（liu / chen / wang），但要排除常见词
  if (/^[a-z]{2,}$/.test(w) && !EN_COMMON_WORDS.has(w)) return true
  return false
}

/**
 * 统计子串在文本中的出现次数（不重叠）
 */
function countOccurrences (text, needle) {
  if (!needle) return 0
  let n = 0
  let idx = text.indexOf(needle)
  while (idx !== -1) {
    n++
    idx = text.indexOf(needle, idx + needle.length)
  }
  return n
}

/**
 * 求某个片段在文本中是「第几次出现」（从 0 起）
 *
 * 用途：给疑似片段一个稳定的定位键。
 *   同一段文字在文中多处出现时，只有「第几次」能区分是哪一处 ——
 *   前端点其中一个，回灌给引擎时才能精确命中。
 *
 * @param {string} text  全文
 * @param {string} needle 片段文本
 * @param {number} start  片段的起始位置
 */
function occurrenceIndex (text, needle, start) {
  if (!needle) return 0
  let nth = 0
  let idx = text.indexOf(needle)
  while (idx !== -1 && idx < start) {
    nth++
    idx = text.indexOf(needle, idx + needle.length)
  }
  return nth
}

/**
 * 求某个片段在文本中第 n 次出现的起始位置（找不到返回 -1）
 */
function nthOccurrence (text, needle, n) {
  if (!needle) return -1
  let idx = text.indexOf(needle)
  for (let k = 0; k < n && idx !== -1; k++) {
    idx = text.indexOf(needle, idx + needle.length)
  }
  return idx
}

/**
 * 找出英文裸全名候选（无称谓、无关系词的「名 + 姓」）
 *
 * 判据与 b5 一致，共享同一张英文姓氏表：
 *   末词在姓氏表内   → 排除 "New York" / "Hong Kong" / "Best Wishes"
 *   首词像名           → 排除 "the nasa" / "love new"
 *   首词不在常见词表   → 排除 "we need ok"
 *   首词不全大写       → 排除 "NASA IBM" 这类缩写
 *
 * @param {string} text
 * @returns {Array<{start:number, end:number, text:string}>}
 */
function findEnNameCandidates (text) {
  const out = []
  const re = /([A-Za-z]+)\s+([A-Za-z]+)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const w1 = m[1]
    const w2 = m[2]
    if (!isEnSurname(w2)) continue
    if (EN_COMMON_WORDS.has(w1.toLowerCase())) continue
    // 全大写缩写（NASA / MIT / OK）不是名
    if (/^[A-Z]{2,}$/.test(w1)) continue
    // 首词要像名：首字母大写 + 小写，或全小写（拼音名）
    const looksGiven = /^[A-Z][a-z]+$/.test(w1) || /^[a-z]{2,}$/.test(w1)
    if (!looksGiven) continue
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
  }
  return out
}

/**
 * 脱敏
 *
 * @param {string} text 原始内容
 * @param {object} [options]
 * @param {Array<{text: string, kind?: string}>} [options.confirmed]
 *   用户在预览里点「一键脱敏」后确认的片段。
 *   引擎会把这些片段**强制脱敏**（不再询问）。
 *   这是「引擎不自动替换 → 用户确认 → 引擎执行」闭环的回灌接口，
 *   保证脱敏逻辑仍然只有一份（前端不自己写替换规则）。
 * @returns {{content: string, changed: boolean, hits: Array<{kind: string, count: number}>, suspected: Array}}
 */
function desensitize(text, options) {
  const src = text || ''
  const hits = []
  let out = src

  // 用户已确认的片段 → 强制脱敏
  //
  // 为什么要这个回灌接口：
  //   L3 层的定位是「引擎拿不准 → 交给用户判断」。
  //   但如果用户判断完，引擎却不能执行，那这个判断就没有意义 ——
  //   用户只能自己手动改文字，一键脱敏就落不了地。
  //
  // 所以确认结果必须**回灌给引擎**，由引擎执行替换。
  // 前端只负责"收集用户点了哪些"，不自己写脱敏规则 ——
  // 否则脱敏逻辑就有两份，浏览器和论坛同步管道会漂移。
  const confirmed = (options && options.confirmed) || []

  // 确认项按「文本 + 第几次出现」索引
  //
  // 为什么不能只按文本匹配：
  //   同一段文字在文中可能多处出现，且只有部分该脱敏
  //   （"刘晓东骂我" 有线索自动脱敏了，"我讨厌刘晓东" 没有）。
  //   只按文本匹配会把已经脱敏的地方再算一遍，或把不该动的位置也动掉。
  //
  // 所以确认项带上「第 N 次出现」，
  // 引擎在处理时数着数，只脱敏被确认的那一次。
  const confirmedMap = new Map()
  for (const c of confirmed) {
    const item = typeof c === 'string' ? { text: c } : c
    if (!item || !item.text) continue
    const key = item.text
    const nth = item.nth || 0
    if (!confirmedMap.has(key)) confirmedMap.set(key, new Set())
    confirmedMap.get(key).add(nth)
  }

  // 每个文本已确认的次数计数器（用于取「第 N 次」的 N）
  const confirmedSeen = new Map()

  /**
   * 判断某个位置的片段是否被用户确认
   *
   * @param {string} fragment 片段文本
   * @param {number} start 在当前文本中的起始位置
   * @param {string} haystack 片段所在的文本（用于统计这是第几次出现）
   */
  function isConfirmed (fragment, start, haystack) {
    const set = confirmedMap.get(fragment)
    if (!set || !set.size) return false
    return set.has(occurrenceIndex(haystack, fragment, start))
  }

  // 已按用户确认强制脱敏的片段数
  let confirmedApplied = 0

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
  //
  // 例外：「姓名的规律」「性别」「姓氏学」里的「姓名」「性别」是普通词，
  //      不是姓氏。要排除，否则会误伤。
  //      判据：X 是「名」「别」「氏」这类通用词时跳过。
  step(/姓(?!(名|别|氏|氏族|名册|名学))([一-龥]{1,2})/g, 'surname',
    function (m, g1) { return M2 + MASK_CN.surname + M2 }, 'cn')

  // ---- 英文补充规则 ----
  //
  // 放在中文规则之后：中文规则会把「的」换成 M3，英文规则不受影响；
  // 反过来则可能被中文规则吃掉英文边界，所以这个顺序不能反。
  //
  // 英文的语序和中文相反 —— 英文是「称谓 + 姓」（Professor Wang），
  // 中文是「姓 + 称谓」（王教授）。两种都覆盖，但主规则必须是「称谓 + 姓」。

  // ---- 英文姓名识别：统一由 L2b 的 b1~b5 处理 ----
  //
  // 曾经这里有 e1~e7 七条独立规则，但它们与 L2b 的 b1~b5 **功能重叠**，
  // 两套规则同时跑会互相破坏：
  //
  //   "professor liu is strict"
  //     e1 先跑 → "professor Someone is strict"
  //     b2 再跑 → "Someone Someone is strict"   ← 「Someone」被当成了姓
  //
  //   "my advisor liu gave me advice"
  //     e3 先跑 → "my advisor Someone gave me advice"
  //     b4 再跑 → "advisor Someone gave me advice"  ← 「my」被吃掉了
  //
  // 老规则的问题是覆盖不全（大小写敏感），新规则 b1~b5 覆盖完整。
  // 所以正确做法是**只保留一套** —— 删除 e1~e7，规则统一在 L2b。

  // ---- L2 上下文加权的姓名识别 ----
  //
  // 处理两类形态上像名字、但缺少称谓锚点的片段：
  //   中文：「我是王小明」「王小明让我很痛苦」
  //   英文：「Mr.liu」「ming liu is my advisor」
  //
  // 判据（必须同时满足）：
  //   形态像名字（姓 + 名字用字）  AND  附近有指人线索
  //
  // 为什么必须要有线索：实测（115 万字真实语料）纯形态判别对普通词的
  // 误伤率 1.48%，人工抽样里真名:普通词 ≈ 41:37 —— 等于随机。
  // 加上上下文后误伤降到可接受范围。
  //
  // L3 兜底：形态像但没线索的，**不自动替换**，而是记进 suspected，
  //          由前端提示用户「这里可能有 N 处姓名未脱敏」。
  //          这是整套架构的关键 —— 把「引擎不知道」从静默失败变成显式告警。

  const suspected = []

  // ---- L2a：中文姓名 ----
  {
    const shapes = NAME_DETECT.findNameShaped(out)
    let cnCount = 0
    // 从后往前替换，避免前面的替换影响后面的位置
    for (let i = shapes.length - 1; i >= 0; i--) {
      const sp = shapes[i]
      const cue = NAME_DETECT.findCue(out, sp.start, sp.end)
      // 用户已确认的片段 → 无条件脱敏（不再等线索）
      const isConfirmedHit = isConfirmed(sp.text, sp.start, out)

      if (cue || isConfirmedHit) {
        // 有线索 或 用户已确认 → 脱敏
        out = out.slice(0, sp.start) + M2 + MASK_CN.person + M2 + out.slice(sp.end)
        cnCount++
        if (isConfirmedHit && !cue) confirmedApplied++
      } else if (sp.shape === 'strict' || sp.shape === 'single') {
        // 无线索但形态强 → 记为疑似，交给前端告警
        suspected.push({
          text: sp.text,
          kind: 'person',
          lang: 'cn',
          start: sp.start,
          end: sp.end,
          nth: occurrenceIndex(out, sp.text, sp.start)
        })
      } else if (sp.uncertain) {
        // 切分位置可疑（前面是虚词）→ 也告警。
        // 宁可多提醒一次，也不要静默漏掉一个真名。
        suspected.push({
          text: sp.text,
          kind: 'person',
          lang: 'cn',
          start: sp.start,
          end: sp.end,
          nth: occurrenceIndex(out, sp.text, sp.start)
        })
      }
    }
    if (cnCount > 0) hits.push({ kind: 'personCn', count: cnCount, lang: 'cn' })
  }

  // ---- L2b：英文姓名（大小写不敏感 + 全名） ----
  //
  // 覆盖用户实测的全部缺口：
  //   Mr.liu / mr. liu / MR.LIU / mR.lIU   （称谓后任意大小写的姓）
  //   ming liu is my advisor               （全小写纯姓形态）
  //   Ming Liu is my advisor               （全名无职称）
  //
  // 关键：英文的姓在句首、名前在后，与中文相反。
  //      所以英文用「两个连续的首字母大写词」或「称谓 + 任意大小写词」作锚点。
  {
    let enCount = 0
    let work = out

    // b1: 缩写称谓 + 任意大小写的姓
    //    Mr.liu / mr. liu / MR.LIU / mR.lIU 都要能识别，
    //    所以称谓本身大小写不敏感。
    //
    //    但后随的「姓」必须**像姓名**，否则会误伤：
    //      "the teacher told me"   → teacher 是泛称，不是称谓锚点
    //      "my prof. Liu"           → prof. 是缩写称谓
    //    判定：姓要么首字母大写、要么全小写但长度 >= 2（英文姓多是小写）
    //         且不能是常见普通词。
    //    「Mr.liu」点号后没有空格，「Mr Liu」有 —— 两种都要覆盖。
    //    所以分隔符是「点号可选 + 空格可选」，但至少要有其中之一
    //    （否则 "Mrliu" 这种拼接也会命中，虽然风险极低）。
    //    后随的姓：只要**不像普通词**就认。
    //    因为「Mr.」本身已经是强锚点 —— 英文里没有 "Mr. office" 这种说法。
    //    这与 b2 不同：b2 的完整称谓在英文里经常单独出现
    //    （"my professor was absent"），没有点号那么强的指向性。
    //    姓可以是复合姓（Smith-Jones）—— **两段都要脱敏**。
    //    只换前半段会留下 "Jones" 这个真名，比漏检更危险（看起来像处理过了）。
    const dotTitle = /\b(Mr|MRS|Ms|DR|PROF|SR|JR)(\.|\s+)\s*([A-Za-z]+(?:[-][A-Za-z]+)?)/gi
    work = work.replace(dotTitle, function (m, g1, sep, g2) {
      // 复合姓：两段都要在姓氏表里
      const parts = g2.split('-')
      const ok = parts.every(function (p) { return isEnSurname(p) })
      if (!ok) return m
      enCount++
      const masked = parts.map(function (p) { return MASK_EN.personEn }).join('-')
      return M2 + g1 + '. ' + masked + M2
    })

    // b2: 完整称谓 + 任意大小写的姓
    //    「my professor was not there」里的 professor 是小写泛称，
    //    所以完整称谓**必须首字母大写**才算锚点。
    //    「PROFESSOR liu」全大写称谓也要能识别，所以用 gi。
    //    但「my professor was not there」里的小写 professor 是泛称，
    //    所以要求：称谓是**首字母大写或全大写**，纯小写的不算锚点。
    //    姓必须**在英文姓氏表里** —— 这一层让判别变干净：
    //      "professor liu is strict" → liu 在表里 → 识别
    //      "my professor was not there" → was 不在表里 → 不动
    //      "the teacher told me" → told 不在表里 → 不动
    const fullTitle = /\b(Professor|Advisor|Supervisor|Teacher|Tutor|Mentor|Coordinator|Director|Head|Chair)\s+([A-Za-z]+(?:[-][A-Za-z]+)?)/gi
    work = work.replace(fullTitle, function (m, g1, g2) {
      const parts = g2.split('-')
      const ok = parts.every(function (p) { return isEnSurname(p) })
      if (!ok) return m
      enCount++
      const masked = parts.map(function (p) { return MASK_EN.personEn }).join('-')
      return M2 + g1 + ' ' + masked + M2
    })

    // b2b: 姓 + 完整称谓（另一种语序）：Liu Professor / WANG Professor
    //      中式英语或简历写法里会出现。
    //      与 b2 不冲突 —— b2 是「称谓 + 姓」，这是「姓 + 称谓」。
    {
      const nameThenTitle = /\b([A-Za-z]+(?:[-][A-Za-z]+)?)\s+(Professor|Advisor|Supervisor|Teacher|Tutor|Mentor|Coordinator|Director|Head|Chair)\b/gi
      work = work.replace(nameThenTitle, function (m, g1, g2) {
        const parts = g1.split('-')
        const ok = parts.every(function (p) { return isEnSurname(p) })
        if (!ok) return m
        enCount++
        const masked = parts.map(function (p) { return MASK_EN.personEn }).join('-')
        return M2 + masked + ' ' + g2 + M2
      })
    }

    // b3: 纯姓形态（关系词锚定）：Liu is my advisor / LIU IS MY ADVISOR
    //     姓可以是任意大小写 —— 关系词已经提供了足够的上下文信号。
    //    姓必须在英文姓氏表里 —— 关系词已经提供了上下文，
    //    再加上姓氏表这一层，判别就很干净了。
    //
    //    捕获组的意义：**只替换姓，其余原样保留**。
    //    「Liu is my advisor」→「Someone is my advisor」，
    //    若整体替换，关系词就丢了，句子读不通。
    const pureName = /\b([A-Za-z]+)(\s+(?:is|was|are|were)\s+(?:my|our|his|her|their)\s+(?:advisor|supervisor|mentor|tutor|teacher|professor|boss|colleague|friend|roommate|partner)\b)/gi
    work = work.replace(pureName, function (m, g1, g2) {
      if (!isEnSurname(g1)) return m
      enCount++
      return M2 + MASK_EN.personEn + M2 + g2
    })

    // b4: 关系词 + 姓（另一语序）：my advisor Liu / her supervisor Wang
    //    同理，人称与关系词都要保留 —— 只把姓换掉。
    const relThenName = /\b((?:my|our|his|her|their)\s+(?:advisor|supervisor|mentor|tutor|teacher|professor|boss|colleague|friend|roommate|partner)\s+)([A-Za-z]+)/gi
    work = work.replace(relThenName, function (m, g1, g2) {
      if (!isEnSurname(g2)) return m
      enCount++
      return M2 + g1 + ' ' + MASK_EN.personEn + M2
    })

    // b5: 全名（名 + 姓），两词都首字母大写或全小写：
    //     Ming Liu / ming liu
    //     要求后接动作动词或关系词，避免误伤 "new york"、"hong kong" 这类地名。
    //    「名 + 姓」结构。关键约束：**末词必须是常见姓氏**。
    //
    //    为什么这是关键：
    //      "Ming Liu"      → 末词 liu 在姓氏表 → 识别
    //      "the teacher"   → 末词 teacher 不在 → 不动
    //      "Other teachers"→ 末词 teachers 不在 → 不动
    //      "New York"      → 末词 york 不在 → 不动
    //    没有姓氏表这一层，靠形态判别会误伤 63% 的负样本。
    const fullName = /\b([A-Za-z]+)\s+([A-Za-z]+)\b(?=\s+(?:called|told|asked|said|yelled|scolded|is|was|keeps|always|never|helped|email|contacted|visited|emailed)\b)/g
    work = work.replace(fullName, function (m, g1, g2) {
      // 末词必须是姓氏
      if (!isEnSurname(g2)) return m
      // 首词要像名：首字母大写+小写，或全小写（拼音名）
      const looksGiven = /^[A-Z][a-z]+$/.test(g1) || /^[a-z]{2,}$/.test(g1)
      if (!looksGiven) return m
      // 全大写是缩写（NASA / MIT），不动
      if (/^[A-Z]{2,}$/.test(g1)) return m
      // 首词是称谓 → 这不是「全名」，而是「称谓 + 姓」。
      //   "professor liu is strict" → b2 已按小写泛称跳过，
      //   若这里再当全名处理，就会输出 "Someone Someone"（称谓被吃掉）。
      //   所以要排除 —— 完整称谓由 b2 处理，缩写称谓由 b1 处理。
      if (isEnTitleWord(g1)) return m
      enCount++
      return M2 + MASK_EN.personEn + ' ' + MASK_EN.personEn + M2
    })

    // b6: 英文机构名 → ___ University
    //     机构词本身也要能匹配全大写（UNIVERSITY）。
    //     与 b5 不冲突 —— b5 要求末词是**姓氏**，而机构词不在姓氏表里。
    //     必须放在 b5 **之后**：否则 "Tsinghua University" 会被 b5
    //     先当成「名 + 姓」处理（university 不在姓氏表里，所以不会，
    //     但顺序上保持「先具体后宽泛」更安全）。
    {
      const orgRe = new RegExp('\\b(' + EN_ORG_NAME + ')\\s+(' + EN_ORG + ')\\b', 'g')
      let orgCount = 0
      work = work.replace(orgRe, function (m, g1, g2) {
        orgCount++
        return M2 + MASK_EN.orgEn + ' ' + g2 + M2
      })
      if (orgCount > 0) hits.push({ kind: 'orgEn', count: orgCount, lang: 'en' })
    }

    out = work
    if (enCount > 0) hits.push({ kind: 'personEn', count: enCount, lang: 'en' })
  }

  // ---- L2c：标识符（学号 / 手机号 / 邮箱 / 社交账号 / 房间号） ----
  //
  // 这些信息同样能定位到个人，而且格式规整，可以用「关键词 + 格式」可靠识别。
  // 放在姓名识别之后 —— 因为姓名替换会改变文本长度，
  // 如果先做标识符，位置会错位。
  {
    const idents = IDENT_DETECT.findIdentifiers(out)
    const counts = {}
    // 从后往前替换
    for (let i = idents.length - 1; i >= 0; i--) {
      const id = idents[i]
      const mask = MASK_CN[identKind(id.kind)] || MASK_CN.identifier
      out = out.slice(0, id.start) + M2 + mask + M2 + out.slice(id.end)
      counts[id.kind] = (counts[id.kind] || 0) + 1
    }
    for (const kind of Object.keys(counts)) {
      hits.push({ kind: 'identifier_' + kind, count: counts[kind], lang: 'cn' })
    }
  }

  // ---- L2d：英文姓名（无称谓、无关系词的裸全名） ----
  //
  // b1~b6 都需要结构锚点（称谓/关系词/后接动词），
  // 所以「Ming Liu 很烦」这种**裸全名**完全够不着 —— 静默漏检。
  //
  // 判据（与 b5 同源，共享姓氏表）：
  //   末词必须是常见姓氏     → 排除 "New York" / "Hong Kong"
  //   首词必须像名           → 排除 "the nasa"
  //   不在常见词表里         → 排除 "love new"
  //
  // 和中文层一样：**只告警，不自动替换**。
  // 「Ming Liu」到底是不是人名，引擎说了不算，用户说了算。
  {
    const enSus = findEnNameCandidates(out)
    // 从后往前替换 —— 正向替换会让后面的候选位置漂移
    for (let i = enSus.length - 1; i >= 0; i--) {
      const cand = enSus[i]
      if (isConfirmed(cand.text, cand.start, out)) {
        // 用户已确认 → 强制脱敏
        out = out.slice(0, cand.start) + M2 + MASK_EN.personEn + M2 + out.slice(cand.end)
        confirmedApplied++
        hits.push({ kind: 'personEn', count: 1, lang: 'en' })
      } else {
        suspected.push({
          text: cand.text,
          kind: 'person',
          lang: 'en',
          start: cand.start,
          end: cand.end,
          nth: occurrenceIndex(out, cand.text, cand.start)
        })
      }
    }
  }

  // ---- L2e：院校简称 ----
  //
  // L1 的机构词规则要求「校名 + 大学/学院」这类带后缀的形式，
  // 所以「清华」「哈工大」这类简称够不着 —— 同样是静默漏检。
  //
  // 简称与普通词高度同形（重大/东南/上交…），
  // 所以不进 L1 自动替换，只进疑似清单（详见 institution-detector.js）。
  {
    const abbrs = INSTITUTION_DETECT.findInstitutionAbbr(out)
    for (let i = abbrs.length - 1; i >= 0; i--) {
      const ab = abbrs[i]
      if (isConfirmed(ab.text, ab.start, out)) {
        // 用户已确认 → 强制脱敏
        out = out.slice(0, ab.start) + M2 + MASK_CN.school + M2 + out.slice(ab.end)
        confirmedApplied++
        hits.push({ kind: 'school', count: 1, lang: 'cn' })
      } else {
        suspected.push({
          text: ab.text,
          kind: 'school',
          lang: 'cn',
          start: ab.start,
          end: ab.end,
          nth: occurrenceIndex(out, ab.text, ab.start)
        })
      }
    }
  }

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

  // 重算疑似片段的位置
  //
  // 为什么必须重算：
  //   L2a 里记下的 start/end 是**中间态**（含 M1~M4 标记、且尚未被后续规则替换）的坐标。
  //   之后的 L2b/L2c/L2d 会不断替换文本，位置必然漂移；
  //   最后又把标记剥掉，长度也变了。
  //   所以最终位置必须在**成品文本**上重新定位。
  //
  // 注意 nth **不重算**：
  //   nth 是「该文本在全文中的第几次出现」，检测时算一次就定了。
  //   它是前端回灌 confirmed 时的定位键 ——
  //   若在成品上重算，编号基准会从「含标记的中间态」变成「剥掉标记的成品」，
  //   与引擎判定 isConfirmed 时用的基准不一致 → 回灌会命中错的位置。
  //
  //   已被用户确认并脱敏的片段会消失 → 搜不到 → 从疑似清单里移除
  //   （前端据此把「已脱敏」和「待确认」区分开）。
  const finalSuspected = []
  for (const s of suspected) {
    // 定位该片段在成品中的**第 s.nth 次出现**
    //
    // 不能直接用 indexOf —— 那只会找到首次出现的位置。
    // 同名片段有多处时，start 必须指向真正的那一处，
    // 否则前端高亮会指错地方。
    const idx = nthOccurrence(out, s.text, s.nth || 0)
    if (idx === -1) continue // 已被脱敏 → 不再是疑似
    finalSuspected.push({
      text: s.text,
      kind: s.kind,
      lang: s.lang,
      start: idx,
      end: idx + s.text.length,
      // 第几次出现 —— 前端回灌 confirmed 时带上它，引擎才能精确定位到这一处
      nth: s.nth || 0,
      // 出现次数 —— 前端用来显示「N 处」
      count: countOccurrences(out, s.text)
    })
  }

  return {
    content: out,
    changed: out !== src,
    hits: hits,
    // suspected：形态可疑但缺少上下文线索、无法自动判定的片段。
    // 前端应把它们显示成「可能有 N 处姓名未脱敏」，让用户自己确认。
    // 这是「不静默失败」的关键 —— 引擎不知道就说不知道。
    suspected: finalSuspected,
    // confirmedApplied：本次因用户确认而被强制脱敏的片段数。
    // 前端用它告诉用户「已按你的确认脱敏了 N 处」。
    confirmedApplied: confirmedApplied
  }
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
