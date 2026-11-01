/**
 * 敏感信息识别基准集（Ground Truth）
 *
 * 这是整个脱敏引擎的**唯一真源**：
 *   scripts/desensitize.js  —— 引擎实现
 *   scripts/eval.js         —— 跑这个基准集
 *   scripts/build-name-dict.py —— 从语料生成姓名词典
 *
 * 设计原则（三条，缺一不可）：
 *
 * 1. **负样本比正样本更重要**
 *    脱敏系统的失败模式不对称：
 *      漏检（真名没脱敏） → 隐私泄露，严重
 *      误伤（普通词被脱敏） → 句子读着别扭，用户会自己看出来
 *    所以负样本（不该动的普通词）必须比正样本更多，
 *    否则引擎会为了召回而滥伤，把产品做废。
 *
 * 2. **每个负样本都是一次「差点犯的错」**
 *    不是随手造的，而是从真实语料的误判清单里挑出来的。
 *    数据来源见 build-name-dict.py 的注释。
 *
 * 3. **标注要含「为什么」**
 *    note 字段写清判据，方便后来者判断这条能不能删。
 */

// ---- 正样本：必须被脱敏 ----

// A. 原有：机构词类
const POS_ORG = [
  '我在星洲大学读研',
  '湖南大学的实验室设备不错',
  '北京邮电大学自动化学院',
  '我在湖南大学读研',
  '每天在湖南大学做实验',
  '每周去星洲大学开会',
  '浙大工学院',
  '我在星洲大学土木工程学院',
  '我们在结构力学实验室通宵做实验'
]

// B. 原有：中文「姓X」与「姓名+称谓」
const POS_CN_PERSON = [
  '我姓李，他总是叫我马上去他的办公室',
  '李老师很凶',
  '欧阳教授训我',
  '陳教授很嚴厲',
  '李（老师）很凶',
  '李[老师]很凶',
  '李 老师很凶',
  '星洲大学（自动化学院）',
  '王小明教授很凶'
]

// C. 原有：英文（大小写 / 后缀 / 连字符 / 语序）
const POS_EN_PERSON = [
  'i was doing my job, and Mr.Liu just called me to go to his office',
  'Professor Wang is very strict with us.',
  'Dr. Smith helped me.',
  'Prof. Zhang told me to stay late.',
  'Ms. Chen gave advice.',
  'I am from Tsinghua University now.',
  'my advisor Liu gave me advice.',
  'Mr.LIU called me',
  'PROFESSOR WANG is strict',
  'MY ADVISOR LIU is strict',
  'TSINGHUA UNIVERSITY',
  'Mr. Liu Jr. called me',
  'Mr. Smith-Jones called me',
  'Liu is my advisor',
  '我们组的 Liu Professor 很强',
  '我在 Tsinghua University 读研，导师姓李'
]

// D. 【本轮新增】英文姓名的「大小写变体」—— 用户反馈的核心痛点
//    关键洞察：只要有称谓锚点，姓可以是任意大小写。
//    因为上下文已经提供了足够强的信号，大小写不该成为漏检的理由。
const POS_EN_CASE = [
  ['Mr.liu called me', '姓全小写 + 缩写称谓'],
  ['mr. liu called me', '称谓全小写 + 姓全小写'],
  ['MR.LIU called me', '全大写'],
  ['Mr.Liu called me', '姓首字母大写'],
  ['mR.lIU called me', '混合大小写'],
  ['Prof.liu told me to stay', 'Prof. + 全小写姓'],
  ['Dr.liu helped me', 'Dr. + 全小写姓'],
  ['professor liu is strict', '全小写完整称谓'],
  ['PROFESSOR liu is strict', '全大写称谓 + 小写姓'],
  ['liu is my advisor', '全小写纯姓形态'],
  ['Liu is my advisor', '纯姓形态'],
  ['LIU is my advisor', '全大写纯姓形态'],
  ['my advisor liu', '全小写 + 职衔'],
  ['my advisor LIU', '全大写 + 职衔'],
  ['Ming Liu is my advisor', '全名无职称（名+姓）'],
  ['Ming Liu called me', '全名无职称 + 动作'],
  ['ming liu is my advisor', '全名全小写']
]

// E. 【本轮新增】中文姓名无职称 —— 靠「姓氏词典 + 名字用字 + 上下文」
//    这类在形态上与普通词高度相似（如「任务」「任何」），
//    所以必须依赖上下文线索，不能只靠形态。
const POS_CN_BARE = [
  ['我是王小明，研二', '自称 + 姓名'],
  ['他叫刘洋，人很坏', '「他叫 + 姓名」'],
  ['王小明让我很痛苦', '姓名 + 动作动词'],
  ['王强说要扣我工资', '姓名 + 说'],
  ['张三是我的导师', '姓名 + 关系词'],
  ['李明辉是我的师兄', '姓名 + 的 + 关系词'],
  ['骂王小明的人真是有病', '动词在前 + 姓名'],
  ['批评刘洋的邮件', '动词在前 + 姓名'],
  ['针对王强的实验数据造假', '针对 + 姓名'],
  ['催我的是赵磊', '主语 + 是 + 姓名'],
  ['折磨我的是陈静', '主语 + 是 + 姓名'],
  ['王小明让我去他办公室', '姓名 + 让我'],
  ['刘洋说我不配毕业', '姓名 + 说'],
  ['导师是欧阳修远', '关系词 + 是 + 姓名']
]

// ---- 负样本：绝不能被脱敏 ----

// F. 【本轮新增】从真实语料误判清单里挑出来的普通词
//    这些是「姓 + 名字用字」形态，但其实是普通词 —— 引擎最容易在这里翻车。
const NEG_LOOKS_LIKE_NAME = [
  '任务', '任何', '任命', '何礼', '余部', '余座', '夏代', '夏季',
  '唐代', '唐初', '宋朝', '宋代', '尹力', '崔杏', '卢山', '卢曼',
  '叶城', '叶林', '何塞', '余米', '余艘', '任制', '任嚣',
  '这周的任务很多', '任何人都能做', '他被任命为主任', '余下的时间不多',
  '何塞的进球很漂亮', '卢梭的著作很有名', '宋代的绘画很强',
  '叶城这个地方不错', '余座的人都到齐了'
]

// G. 原有负样本：泛称与固定搭配
const NEG_GENERIC = [
  '我们学校最近换了新食堂',
  '一个大学的环境很重要',
  '今天学院有活动',
  '他们学院的规定很严',
  '隔壁学院的同学说',
  '附近学院的老师很好',
  '那位老师很和善',
  '其他老师也这么说过',
  '这位老师是我的导师',
  '我的导师姓名的规律',
  '他的导师很严格',
  '被批评的时候要接受',
  '我们组的老师说可以',
  '我们实验室的设备不错',
  '这个实验室很大',
  '我们的实验室在五楼',
  '在实验室待到十点',
  '每天在实验室做实验',
  '每周去实验室开会',
  '我在研究生院读研'
]

// H. 原有负样本：英文
const NEG_EN = [
  'the teacher told me to stay late',
  'I went to the office and my professor was not there.',
  'I love New York and MIT is famous.',
  'I work at NASA and IBM.',
  'He said OK to me.',
  'the NASA building',
  'I am from MIT',
  'I am a Professor of Physics',
  'I applied to university last year.',
  'We need OK Liu to sign this',
  'Other teachers said so'
]

// I. 【本轮新增】标识符类 —— 姓名之外的、同样能定位到个人的信息
//
//    这类信息的判别逻辑与姓名完全不同：
//      姓名   —— 形态不可判定，靠上下文
//      标识符 —— 格式高度规整，靠「关键词 + 格式」双重约束
//    所以必须分成独立模块（identifier-detector.js），不能塞进姓名规则里。
const POS_IDENTIFIER = [
  ['学号 2022310108', '学号'],
  ['工号是 20230001', '工号'],
  ['我的学号 2022310108', '学号 + 8~12 位数字'],
  ['手机 13800138000', '手机号（无分隔）'],
  ['电话 138-0013-8000', '手机号（带横线）'],
  ['联系方式 13800138000', '联系方式提示词'],
  ['邮箱 zhangsan@example.edu.cn', '邮箱'],
  ['发到 li.si@xxx.edu.cn', '发到 + 邮箱'],
  ['QQ 123456789', 'QQ 号'],
  ['微信 zhangsan_1999', '微信号'],
  ['工位在科研楼 5-317', '楼-房号'],
  ['房间 402', '纯房号']
]

// J. 标识符负样本：普通数字绝不能被当成标识符
//
//    这是标识符识别最大的风险 —— 数字在学术文本里太常见了。
//    规则必须要求提示词，否则「2024年」「120分」全都会被误伤。
const NEG_IDENTIFIER = [
  '2024年是重要的一年',
  '我考了120分',
  '第3章讲得很清楚',
  '这篇论文有5000字',
  '他在5楼上课',
  '我们班有30人',
  '项目预算100万',
  '实验重复了3次',
  '11月有考试',
  '2021年我本科毕业',
  '一共12个人参加了会议',
  '跑了30公里'
]

// K. 【本轮新增】院校简称 —— L1 规则够不着，只能进疑似清单
//
//    p4 要求「校名 + 大学/学院」，所以「清华」「哈工大」这类简称
//    原本是**静默漏检**（既没脱敏，也没告警）。
//
//    简称与普通词高度同形，所以只能告警 + 由用户确认，
//    不能自动替换 —— 这是 L3 层的核心原则。
//
//    标注方式：
//      'alert'  → 应当进疑似清单（引擎该问用户）
//      'keep'   → 不该进清单，也不能被替换
const SUSPECT_INSTITUTION = [
  ['我在清华读研', 'alert', '简称 + 读研语境', '清华'],
  ['清华的导师很push', 'alert', '简称 + 导师语境', '清华'],
  ['中科大的老师', 'alert', '三字简称', '中科大'],
  ['本科在复旦', 'alert', '简称 + 学历语境', '复旦'],
  ['师兄来自西交', 'alert', '简称 + 来历语境', '西交'],
  ['北大荒的开发', 'keep', '「北大荒」是地名，不是北大', '北大'],
  ['重大意义', 'keep', '「重大」是常用词', null],
  ['上交作业', 'keep', '「上交」是常用词', null],
  ['武大郎烧饼', 'keep', '「武大郎」是小说人物', '武大'],
  ['华大基因', 'keep', '「华大」是公司名', null],
  ['东南方向', 'keep', '「东南」是方位词', null],
  ['南大街的店', 'keep', '「南大」被误切', '南大'],
  ['在重大项目中', 'keep', '「重大」是常用词', null]
]

// L. 【本轮新增】英文裸全名 —— b1~b6 都需要结构锚点，裸全名够不着
//
//    「Ming Liu 很烦」这种既无称谓也无关系词，
//    原本是**静默漏检**。末词必须在姓氏表内，才可能是人名。
const SUSPECT_EN_NAME = [
  ['Ming Liu 很烦', 'alert', '裸全名，末词是姓', 'Ming Liu'],
  ['John Smith 很烦', 'alert', '裸全名', 'John Smith'],
  ['Wei Wang 很烦', 'alert', '全小写拼音名', 'Wei Wang'],
  ['i love new york', 'keep', '「York」不是姓', null],
  ['best wishes', 'keep', '「wishes」不是姓', null],
  ['hong kong', 'keep', '地名', null],
  ['the nasa building', 'keep', '「nasa」不是姓', null],
  ['machine learning', 'keep', '「learning」不是姓', null],
  ['new year', 'keep', '「year」不是姓', null]
]

// M. 【本轮新增】用户确认强制脱敏 —— 「一键脱敏」的回灌路径
//
//    引擎拿不准 → 告警 → 用户点「一键脱敏」→ 片段回灌引擎 → 强制脱敏。
//    这是 L3 层的闭环，缺了它「一键脱敏」就落不了地。
//
//    标注方式：
//      text      原文
//      confirmed 回灌引擎的确认项（text + nth 定位键）
//      expected  确认后的完整输出
const CONFIRMED = [
  ['我讨厌刘晓东', [{ text: '刘晓东', nth: 0 }], '我讨厌某', '中文姓名'],
  ['我在清华读研', [{ text: '清华', nth: 0 }], '我在某校读研', '院校简称'],
  ['Ming Liu 很烦', [{ text: 'Ming Liu', nth: 0 }], 'Someone 很烦', '英文姓名'],
  ['我讨厌刘晓东，刘晓东很烦',
    [{ text: '刘晓东', nth: 0 }],
    '我讨厌某，刘晓东很烦',
    '只脱敏被确认的那一处（第 0 处）'],
  ['我讨厌刘晓东，刘晓东很烦',
    [{ text: '刘晓东', nth: 1 }],
    '我讨厌刘晓东，某很烦',
    'nth 定位到第 1 处'],
  ['我在清华读研，清华的食堂很难吃',
    [{ text: '清华', nth: 0 }],
    '我在某校读研，清华的食堂很难吃',
    '同名多处只确认第 0 处']
]

module.exports = {
  POS_ORG, POS_CN_PERSON, POS_EN_PERSON,
  POS_EN_CASE, POS_CN_BARE, POS_IDENTIFIER,
  NEG_LOOKS_LIKE_NAME, NEG_GENERIC, NEG_EN, NEG_IDENTIFIER,
  SUSPECT_INSTITUTION, SUSPECT_EN_NAME, CONFIRMED
}
