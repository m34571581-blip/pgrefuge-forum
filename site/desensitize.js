/*
 * PGrefuge 脱敏引擎（浏览器版）
 *
 * 由 scripts/build-browser-engine.js 自动生成，请勿手改。
 * 源文件：scripts/desensitize.js + name-detector.js + identifier-detector.js
 *
 * 依赖已内联，无外部引用 —— 直接 <script> 引入即可。
 */
;(function () {
  'use strict'

  var __modules = {}
  var __cache = {}
  function __require (name) {
    if (__cache[name]) return __cache[name].exports
    var m = __cache[name] = { exports: {} }
    var fn = __modules[name]
    if (!fn) throw new Error('[PGDesensitize] missing module: ' + name)
    // 模块里的 `module.exports = X` 改的是 m.exports 这个对象的属性，
    // 调用方拿到的就是它 —— 与 CommonJS 语义一致。
    fn(m)
    return m.exports
  }

  // ---- name-detector.js ----
  __modules["name-detector"] = function (module) {
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
    const NAME_CHARS = __require("name-dict").nameChars

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

  }

  // ---- identifier-detector.js ----
  __modules["identifier-detector"] = function (module) {
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
    // 三种写法都覆盖：13800138000 / 138-0013-8000 / 138 0013 8000
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

  }

  // ---- desensitize.js ----
  __modules["desensitize"] = function (module) {
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
    const NAME_DETECT = __require("name-detector")

    /**
     * 标识符识别模块（学号 / 手机号 / 邮箱 / 社交账号 / 房间号）
     *
     * 与姓名分开处理，因为两类信息的判别逻辑完全不同：
     *   姓名   —— 形态不可判定，必须靠上下文
     *   标识符 —— 格式高度规整，用「关键词 + 格式」双重约束即可
     *
     * 详见 identifier-detector.js 的头部注释。
     */
    const IDENT_DETECT = __require("identifier-detector")

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

          if (cue) {
            // 有线索 → 脱敏
            out = out.slice(0, sp.start) + M2 + MASK_CN.person + M2 + out.slice(sp.end)
            cnCount++
          } else if (sp.shape === 'strict' || sp.shape === 'single') {
            // 无线索但形态强 → 记为疑似，交给前端告警
            suspected.push({ text: sp.text, kind: 'person', lang: 'cn' })
          } else if (sp.uncertain) {
            // 切分位置可疑（前面是虚词）→ 也告警。
            // 宁可多提醒一次，也不要静默漏掉一个真名。
            suspected.push({ text: sp.text, kind: 'person', lang: 'cn' })
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

      return {
        content: out,
        changed: out !== src,
        hits: hits,
        // suspected：形态可疑但缺少上下文线索、无法自动判定的片段。
        // 前端应把它们显示成「可能有 N 处姓名未脱敏」，让用户自己确认。
        // 这是「不静默失败」的关键 —— 引擎不知道就说不知道。
        suspected: suspected
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

    if (true) {
      module.exports = API
    }
    if (typeof window !== 'undefined') {
      window.PGDesensitize = API
    }

  }

  // ---- name-dict.json ----
  __modules["name-dict"] = function (module) {
    module.exports = {"nameChars":["七","万","丈","世","丘","丙","业","东","丝","丞","严","中","丰","临","丹","为","丽","举","乃","久","义","之","乐","乔","九","也","习","书","乾","予","争","于","云","五","井","亦","享","京","亭","亮","亲","亿","仁","仆","今","介","从","仓","仔","仕","仗","付","仙","仟","代","令","以","仪","仰","仲","价","任","企","伊","伍","众","优","伟","传","伦","伯","伶","伸","似","伽","位","住","佐","佑","体","何","余","佟","佩","佰","佳","佻","依","侠","侣","侥","侯","俄","俊","俗","保","俞","信","俪","俭","修","俸","倘","倚","倜","倩","倪","健","傲","僚","儒","儿","允","元","兆","先","光","克","兔","全","公","兰","共","兴","其","兼","内","冉","册","冕","军","冠","冬","冰","冲","冶","冷","净","准","凉","凌","凝","凡","凤","凯","凰","函","刊","列","刚","初","利","剑","力","功","加","助","励","劲","勇","勉","勋","勘","勤","匀","化","北","匠","千","升","卉","华","卓","南","博","卡","卫","卯","即","卷","卿","厉","厚","原","厦","又","友","双","发","叙","古","句","召","可","台","右","叶","合","吉","同","名","向","君","吟","含","听","启","员","呜","和","品","哈","哲","唐","唯","商","啸","善","喜","喻","嘉","器","囊","回","因","园","固","国","图","圆","土","圣","地","圳","圻","均","坎","坚","坡","坤","坦","坪","垣","城","埔","培","基","堂","境","壁","壑","壤","士","壬","壮","处","备","复","夏","夕","多","夜","天","太","夫","夷","奇","奉","奋","奔","奕","奥","好","如","妍","妙","妞","妤","妮","妹","姆","姑","姗","姝","姬","姿","威","娅","娇","娜","娟","娥","娴","婉","婕","婧","婵","婷","媚","媛","嫣","嫦","子","字","存","孟","季","学","宁","宇","守","安","宏","宙","定","宛","宜","宝","实","客","宵","家","宸","容","宽","宿","寄","寇","富","寒","察","寥","寻","封","尊","小","少","尔","尘","尚","尧","尹","尺","尼","局","届","屏","展","履","山","岁","岗","岚","岩","岳","峙","峥","峪","峰","峻","崇","崎","崧","嵋","嶂","川","州","巡","工","巧","巨","己","巾","布","帆","师","希","帏","帕","帙","帜","带","席","常","幄","平","年","幸","幻","幼","幽","庄","庆","序","度","庭","庶","康","庸","廉","廓","延","廷","建","开","弈","弓","引","弗","弘","弥","强","当","形","彤","彦","彩","彪","彬","彰","影","役","彻","征","律","徐","得","御","循","微","德","心","忆","志","忠","念","怀","怜","思","怡","恃","恋","恍","恒","恩","恫","恬","恭","恰","悟","悠","悦","情","惜","惟","惠","愈","意","慈","慎","慕","慧","懿","戈","戊","戏","成","戒","户","才","扬","扰","承","抒","抗","折","抱","拓","招","拯","挚","振","挺","捷","描","播","擎","攀","政","敏","散","敦","敬","数","文","斌","料","斡","斤","斯","新","方","施","旃","旅","旋","既","日","旦","旨","旬","旭","时","旷","昂","昆","昊","昌","明","易","昔","昕","昙","星","映","春","昧","昭","昱","晋","晏","晓","晖","晟","晦","晨","普","景","晴","晶","智","暖","暮","曜","曦","曲","曼","月","有","朋","朔","朗","望","朝","木","本","朴","朵","机","权","杉","杏","材","村","杜","杞","来","杨","杭","杯","杰","松","极","析","枕","林","枚","果","枝","枫","柏","柑","柔","柯","柳","栅","标","栋","树","栗","校","栩","株","核","格","桂","桃","桐","桑","桦","梁","梅","梓","梦","梨","梭","棋","棕","棠","森","椰","楚","楠","楷","榆","榕","槐","槽","樊","樱","橙","欢","欣","欧","欲","歆","歇","歌","正","武","毅","毫","民","水","永","汛","汝","江","池","汪","汰","沁","沐","沙","沛","沧","河","治","泉","泊","波","泥","泰","泽","洁","洋","洛","津","洪","洲","洹","洽","流","浅","济","浙","浚","浦","浩","浪","海","涉","涌","涛","润","涧","涯","涵","淑","淘","淡","深","清","渊","渐","渔","渝","渠","温","港","湖","湘","湛","源","溢","溪","溯","滔","滟","满","滢","滨","漂","漩","漫","漾","潜","潭","潮","澜","激","瀚","火","灵","灿","炎","炙","炜","炫","烈","烟","烽","然","煊","煜","煦","照","熙","熟","燕","爱","爽","牛","牧","物","特","犀","状","献","玄","玉","玖","玛","玟","玫","玮","玲","玳","珂","珉","珊","珍","珠","班","珲","琅","理","琛","琢","琦","琪","琬","琰","琳","琴","琼","瑗","瑜","瑞","瑶","瑾","璇","璋","璐","甘","甜","生","用","田","由","甲","畅","界","畔","留","略","番","疏","登","白","百","皆","皎","皓","盈","益","盛","直","相","盼","省","眈","眉","真","睛","睹","睿","瞻","矜","知","石","砂","研","硕","碧","磊","磨","示","礼","祈","祖","神","祥","祯","祺","禅","福","禧","禹","禾","秀","秉","秋","积","稳","穆","穗","究","空","立","章","童","端","竹","笑","笙","笛","笠","等","策","筝","筠","筱","简","箴","簇","粉","粟","精","素","索","紫","絮","红","约","级","纬","纯","纱","纲","纳","纹","纽","纾","细","绍","统","绢","绩","绫","绮","维","绵","绿","缘","缙","缦","美","羡","群","羽","翊","翌","翎","翔","翠","翡","翰","翱","翼","耀","考","者","而","耐","耕","耶","耿","联","聚","聪","聿","肃","肖","育","胜","胤","脉","腾","臣","自","至","致","臻","舒","舜","舞","舟","航","舵","良","艳","艺","节","芊","芍","芙","芝","芦","芩","芬","芭","芮","芯","花","芳","芷","芸","芹","苇","苑","苗","苛","若","英","苹","茂","茄","茗","茜","茵","茹","荐","荔","荣","荷","莉","莎","莫","莱","莲","莹","莺","菁","菊","菡","菱","菲","萌","萍","萝","营","萧","萨","萱","葛","葵","葶","蒙","蓉","蓓","蓝","蕊","蕙","蕴","蕾","薇","藏","虎","虑","虞","虹","蛟","蜜","蝶","融","行","衍","街","衙","衷","袁","裕","裳","裴","西","见","观","规","觅","视","觉","解","言","詹","誉","誓","讪","记","讷","论","识","诗","诚","话","询","诣","诩","语","诺","谅","谈","谊","谏","谐","谦","谨","谷","豆","豪","豫","贝","贞","财","责","贤","质","贯","贵","贸","费","贾","资","赏","赢","赤","赴","起","超","越","趣","跃","路","轩","辅","辉","辑","辰","达","迁","迅","迈","迎","运","近","进","远","迪","适","逊","通","逢","逸","道","遥","邑","邦","邹","邻","都","酌","酩","醇","采","释","里","重","野","量","金","鉴","鑫","针","钏","钟","钦","钧","钰","钱","铁","铃","铜","铭","银","锋","锐","锡","锦","锻","镇","镜","长","问","闲","闵","闺","闻","阅","阔","阡","阳","阿","际","陌","限","险","陵","隆","随","雁","雄","雅","集","雍","雨","雪","雯","雷","霄","震","霎","霏","霓","霖","霜","霞","露","青","靓","靖","静","非","革","韬","音","韵","韶","顷","顺","顾","颀","颇","颖","颜","风","飘","飞","饰","香","馥","馨","驰","驿","骄","高","鱼","鸣","鸥","鸿","鹏","鹤","鹰","麒","默","黛","鼎","齐","龄","龙"],"surnames":["王","李","张","刘","陈","杨","黄","赵","吴","周","徐","孙","马","朱","胡","郭","何","高","林","罗","郑","梁","谢","宋","唐","许","邓","冯","韩","曹","曾","彭","萧","蔡","潘","田","董","袁","余","叶","蒋","杜","苏","魏","程","吕","丁","沈","任","姚","卢","傅","钟","姜","崔","谭","廖","范","汪","陆","金","石","戴","贾","韦","夏","邱","方","侯","邹","熊","孟","秦","白","江","阎","薛","尹","段","雷"],"compoundSurnames":["欧阳","司马","上官","诸葛","东方","皇甫","尉迟","公孙","慕容","长孙","宇文","司徒","司空","端木","南宫","夏侯"],"enSurnames":["smith","johnson","williams","brown","jones","garcia","miller","davis","rodriguez","martinez","hernandez","lopez","gonzalez","wilson","anderson","thomas","taylor","moore","jackson","martin","lee","perez","thompson","white","harris","sanchez","clark","ramirez","lewis","robinson","walker","young","allen","king","wright","scott","torres","nguyen","hill","flores","green","adams","nelson","baker","hall","rivera","campbell","mitchell","carter","roberts","wang","li","zhang","liu","chen","yang","huang","zhao","wu","zhou","xu","sun","ma","zhu","hu","guo","he","gao","lin","luo","zheng","liang","xie","song","tang","deng","feng","han","cao","zeng","peng","xiao","cai","pan","tian","dong","yuan","yu","ye","jiang","du","su","wei","cheng","lv","ding","shen","ren","yao","lu","fu","zhong","cui","tan","liao","fan","jin","qian","shu","meng"],"blockBigrams":["方面","方向","方案","方法","方程","程度","工程","成功","成果","白天","明白","明天","昨天","今日","去年","今年","每月","每天","马路","马上","马桶","马车","马力","云龙","云飞","毛巾","毛病","老虎","兔子","猴子","狮子","车子","桌子","房子","叶子","花生","水果","米饭","面粉","战争","战士","武力","日记","日期","时候","时间","钟表","钟声","唐山","武汉","成都","南京","北京","上海","广州","长江","黄河","白色","百事","百姓","百分","百年","千万","万一","问题","风机","闪电","雷鸣","雷达","雪山","雷区","范围","章程","于是","何况","何时","姓王","余下","段落","台阶","任务","任命","任何","主任","何塞","何礼","余部","余座","夏代","夏季","宋代","唐初","唐朝","明朝","元朝","汉朝","民国","唐代","古代","现代","当代","近代","上代","下代","千代","万代","迭代","存款","存量","定向","定期","定点","定位","定时","定量","定性","定律","定额","定价","定制","定义","定理","任制","任嚣","余米","余艘","叶城","叶林","卢山","卢曼","尹力","崔杏","任中共","任中国"]}
  }

  // 暴露到全局
  var DES = __require("desensitize")
  window.PGDesensitize = DES
})()
