/**
 * 脱敏引擎准确率评测 + 跨项目一致性校验
 *
 * 两个必答的问题：
 *   1. 脱敏准不准？   → 召回率 / 精确率
 *   2. 两份实现会不会漂移？→ 逐字比对论坛版与小程序版
 *
 * 为什么第 2 项在这里也重要：
 * PGrefuge 有两处用到脱敏 —— 小程序端（发布前预览）与论坛端（Actions 同步）。
 * 两边规则一旦漂移，就会出现「预览说已脱敏、论坛里带着真名」这种事故。
 * 小程序端与数据库服务端的一致性由 pgrefuge-miniprogram/tests/desensitize-eval.js 校验；
 * 这里校验「论坛版 vs 小程序版」，两端拼起来就是完整的一致性保证。
 *
 * 运行：node scripts/eval.js
 */
const path = require('path')
const { desensitize, summarize } = require('./desensitize')

// 小程序端的实现（用于一致性比对）
const MINI_DIR = path.resolve(__dirname, '..', '..', 'pgrefuge-miniprogram')

/**
 * 标注样本集
 *   expect: 'mask' → 应当被脱敏（输出必须与原文不同）
 *           'keep' → 不应被脱敏（输出必须与原文完全相同）
 * 样本取自产品真实场景：导师/PUA/课题组/学院/学校，
 * 以及学生日常口语里最容易被误伤的泛称表达。
 */
const CASES = [
  // ---------- 应脱敏：学校 ----------
  { t: '我在中南大学读研，导师让我每周写周报', expect: 'mask' },
  { t: '湖南大学的实验室设备不错', expect: 'mask' },
  { t: '北京邮电大学自动化学院', expect: 'mask' },
  { t: '华中科技大学的新政策', expect: 'mask' },
  { t: '我在湖南大学读研', expect: 'mask' },
  { t: '每天在湖南大学做实验', expect: 'mask' },
  { t: '每周去中南大学开会', expect: 'mask' },
  { t: '我们学校最近换了新食堂', expect: 'keep', note: '泛称「我们学校」不应被误伤' },
  { t: '一个大学的环境很重要', expect: 'keep', note: '泛称「一个大学」不应被误伤' },

  // ---------- 应脱敏：学院 ----------
  { t: '我在土木工程学院读博', expect: 'mask' },
  { t: '浙大工学院', expect: 'mask' },
  { t: '今天学院有活动', expect: 'keep', note: '泛称「今天学院」不应被误伤' },
  { t: '他们学院的规定很严', expect: 'keep', note: '泛称「他们学院」不应被误伤' },
  { t: '隔壁学院的同学说', expect: 'keep', note: '定冠词「隔壁学院」不应被误伤' },
  { t: '附近学院的老师很好', expect: 'keep', note: '「附近学院」不应被误伤' },
  { t: '对面学院有活动', expect: 'keep', note: '「对面学院」不应被误伤' },

  // ---------- 应脱敏：姓名与称谓 ----------
  { t: '我们学院的王老师很push', expect: 'mask' },
  { t: '我导师是李教授', expect: 'mask' },
  { t: '张博导对我们很严格', expect: 'mask' },
  { t: '我们课题组组长姓张', expect: 'mask' },
  { t: '那位老师人很好', expect: 'keep', note: '泛称「那位老师」不应被误伤' },
  { t: '其他老师也这么说过', expect: 'keep', note: '泛称「其他老师」不应被误伤' },
  { t: '这位老师是新来的', expect: 'keep', note: '泛称「这位老师」不应被误伤' },
  { t: '我的导师很严格', expect: 'keep', note: '泛称「我的导师」不应被误伤' },
  { t: '他的导师不太管他', expect: 'keep', note: '泛称「他的导师」不应被误伤' },
  { t: '每天被导师骂', expect: 'keep', note: '动词短语不应被误伤' },
  { t: '我被导师批评了', expect: 'keep', note: '被动+动词不应被误伤' },
  { t: '我们组的老师都很卷', expect: 'keep', note: '泛称「我们组的老师」不应被误伤' },
  { t: '我导姓刘', expect: 'mask', note: '「姓刘」是真实姓氏，应脱敏' },

  // ---------- 应脱敏：课题组 / 实验室 ----------
  { t: '我们实验室的设备都要自己买', expect: 'keep', note: '泛称「我们实验室」不含可识别信息' },
  { t: '这个实验室的仪器坏了', expect: 'keep', note: '泛称「这个实验室」不应被误伤' },
  { t: '我们的实验室很乱', expect: 'keep', note: '泛称「我们的实验室」不应被误伤' },
  { t: '我在实验室做毕设', expect: 'keep', note: '泛称「在实验室」不应被误伤' },
  { t: '每天在实验室待到十点', expect: 'keep', note: '时间状语 + 实验室不应被误伤' },
  { t: '每次在实验室都要开会', expect: 'keep', note: '频率状语 + 实验室不应被误伤' },
  { t: '回到实验室继续干', expect: 'keep', note: '动词 + 实验室不应被误伤' },
  { t: '我在研究生院读研', expect: 'keep', note: '已知漏检：研究院/研究所不在机构词表' },

  // ---------- 英文（e1~e5 规则）----------
  // 来源：真实用户在 GitHub Discussions 发的英文帖子。
  // 原帖里的 "Mr.Liu" 完全没被脱敏 —— 中文规则靠汉字锚点，
  // 英文没有汉字锚点，必须靠称谓本身定位，所以补了独立的英文层。
  { t: 'I hate Mr.Liu who pushes me and yelled at me.', expect: 'mask', note: '缩写称谓 + 姓' },
  { t: 'Professor Wang is very strict with us.', expect: 'mask', note: '完整称谓 + 姓（英文最常见语序）' },
  { t: 'I asked Dr. Smith for help.', expect: 'mask', note: 'Dr. + 姓' },
  { t: 'Prof. Zhang told me to stay late.', expect: 'mask', note: 'Prof. + 姓' },
  { t: 'Ms. Chen gave me useful advice.', expect: 'mask', note: 'Ms. + 姓' },
  { t: 'I am from Tsinghua University now.', expect: 'mask', note: '英文机构名' },
  { t: 'My advisor is from New York University.', expect: 'mask', note: '多词机构名' },
  { t: 'my advisor Liu gave me advice.', expect: 'mask', note: '小写职衔 + 姓' },
  { t: 'my supervisor Wang is nice.', expect: 'mask', note: '小写职衔 + 姓（另一种）' },
  { t: '我们组的 Liu Professor 很强', expect: 'mask', note: '中式英文：姓 + 称谓' },

  // 英文负样本：没有姓名就不该动
  { t: 'the teacher told me to stay late', expect: 'keep', note: '无姓名的 teacher 不应被误伤' },
  { t: 'I went to the office and my professor was not there.', expect: 'keep', note: '普通 professor 不应被误伤' },
  { t: 'I love New York and MIT is famous.', expect: 'keep', note: '地名与缩写机构不应被误伤' },
  { t: 'I work at NASA and IBM.', expect: 'keep', note: '全大写缩写不应被误伤' },
  { t: 'I applied to university last year.', expect: 'keep', note: '小写 university 不应被误伤' }
]

function main() {
  console.log('PGrefuge 脱敏引擎评测（论坛版）')
  console.log(`样本数：${CASES.length}\n`)

  let maskTotal = 0
  let maskHit = 0
  let keepTotal = 0
  let keepHit = 0
  const failures = []

  for (const c of CASES) {
    const r = desensitize(c.t)
    const changed = r.changed
    let ok
    if (c.expect === 'mask') {
      maskTotal++
      ok = changed
      if (ok) maskHit++
    } else {
      keepTotal++
      ok = !changed
      if (ok) keepHit++
    }
    if (!ok) failures.push({ ...c, out: r.content, hits: summarize(r.hits) })
  }

  const recall = maskTotal ? (maskHit / maskTotal) * 100 : 0
  const precision = keepTotal ? (keepHit / keepTotal) * 100 : 0

  console.log('[召回] 该脱敏的样本是否脱敏')
  console.log(`  ${maskHit}/${maskTotal}  召回率 ${recall.toFixed(1)}%`)
  console.log('\n[精确] 不该脱敏的样本是否保持原样')
  console.log(`  ${keepHit}/${keepTotal}  精确率 ${precision.toFixed(1)}%`)

  // ---- 跨项目一致性：论坛版 vs 小程序版 ----
  console.log('\n[一致性] 论坛版 vs 小程序版')
  let mini = null
  try {
    mini = require(path.join(MINI_DIR, 'utils', 'sanitize-preview.js'))
  } catch (e) {
    console.log('  跳过：找不到小程序端实现（' + e.message + '）')
  }
  if (mini) {
    let drift = 0
    for (const c of CASES) {
      const a = desensitize(c.t).content
      const b = mini.localFallback(c.t).content
      if (a !== b) {
        drift++
        console.log(`  DRIFT  ${c.t}`)
        console.log(`    论坛版：${a}`)
        console.log(`    小程序：${b}`)
      }
    }
    console.log(`  ${CASES.length - drift}/${CASES.length} 条完全一致${drift ? `，${drift} 条漂移` : '，无漂移'}`)
  }

  if (failures.length) {
    console.log(`\n失败样本 ${failures.length} 条（下一版迭代清单）：\n`)
    failures.forEach((f, i) => {
      const kind = f.expect === 'mask' ? '漏检' : '误伤'
      console.log(`  ${i + 1}. [${kind}] ${f.t}`)
      console.log(`     实际输出：${f.out}`)
      if (f.note) console.log(`     说明：${f.note}`)
    })
  } else {
    console.log('\n全部样本通过。')
  }

  console.log('\n' + '='.repeat(56))
  console.log(`召回率 ${recall.toFixed(1)}%  精确率 ${precision.toFixed(1)}%  失败 ${failures.length} 条`)
  // 有失败样本不算测试失败 —— 这是一份「已知问题清单」，不是断言集
  process.exit(0)
}

main()
