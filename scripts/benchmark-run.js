/**
 * 基准评测（跑 benchmark.js）
 *
 * 输出三个指标：
 *   召回率  —— 该脱敏的有没有脱敏（漏检 = 隐私泄露）
 *   精确率  —— 不该动的有没有乱动（误伤 = 体验受损）
 *   告警数  —— L3 兜底捕获的疑似片段（引擎不确定的，交给用户）
 *
 * 告警不是失败。它是「引擎承认自己不确定」——
 * 比静默漏检好，比乱猜好。
 */
const { desensitize, summarize } = require('./desensitize')
const B = require('./benchmark')

function runGroup (name, cases, expectMask) {
  let pass = 0
  const fails = []
  let alerted = 0

  for (const item of cases) {
    const text = typeof item === 'string' ? item : item[0]
    const note = typeof item === 'string' ? '' : (item[1] || '')
    const r = desensitize(text)
    const masked = r.content !== text
    const ok = masked === expectMask
    if (ok) pass++
    else fails.push({ text: text, note: note, out: r.content, suspected: r.suspected })
    if (r.suspected && r.suspected.length) alerted++
  }

  const total = cases.length
  const rate = ((pass / total) * 100).toFixed(1)
  console.log(
    (pass === total ? '✓' : '✗') + ' ' + name.padEnd(26) +
    ' ' + String(pass).padStart(3) + '/' + total +
    '  (' + rate + '%)' +
    (alerted ? '  告警 ' + alerted : '')
  )
  return fails
}

function runExactGroup (name, cases) {
  // 用例格式：[输入, 期望完整输出, 备注]
  //
  // 与 runGroup 的区别：runGroup 只检查「有没有被脱敏」，
  // 这里检查**逐字输出** —— 拼音姓名场景下，
  // 「脱敏了但只脱了一半」也算失败（会留下姓氏）。
  let pass = 0
  const fails = []
  for (const item of cases) {
    const [text, expected, note] = item
    const r = desensitize(text)
    const ok = r.content === expected
    if (ok) pass++
    else fails.push({ text, note, out: r.content, expected })
  }
  const total = cases.length
  const rate = ((pass / total) * 100).toFixed(1)
  console.log(
    (pass === total ? '✓' : '✗') + ' ' + name.padEnd(26) +
    ' ' + String(pass).padStart(3) + '/' + total +
    '  (' + rate + '%)'
  )
  return fails
}

console.log('='.repeat(74))
console.log('脱敏引擎基准评测')
console.log('='.repeat(74))
console.log()

let allFails = []
allFails = allFails.concat(runGroup('机构词', B.POS_ORG, true))
allFails = allFails.concat(runGroup('中文姓名+称谓', B.POS_CN_PERSON, true))
allFails = allFails.concat(runGroup('英文姓名', B.POS_EN_PERSON, true))
allFails = allFails.concat(runGroup('英文大小写变体', B.POS_EN_CASE, true))
allFails = allFails.concat(runGroup('中文无职称姓名', B.POS_CN_BARE, true))
allFails = allFails.concat(runGroup('标识符（学号/电话等）', B.POS_IDENTIFIER, true))
allFails = allFails.concat(runExactGroup('拼音姓名（连写/姓在前）', B.POS_PINYIN_NAME))
console.log()
allFails = allFails.concat(runGroup('负·形似姓名的普通词', B.NEG_LOOKS_LIKE_NAME, false))
allFails = allFails.concat(runGroup('负·泛称与固定搭配', B.NEG_GENERIC, false))
allFails = allFails.concat(runGroup('负·英文普通词', B.NEG_EN, false))
allFails = allFails.concat(runGroup('负·普通数字', B.NEG_IDENTIFIER, false))
allFails = allFails.concat(runExactGroup('负·形似拼音的英文词', B.NEG_PINYIN_NAME))

// ---- 疑似清单：应告警 / 不应告警 ----
//
// 与「脱敏与否」是两种不同的判据：
//   脱敏测试看的是 content 有没有变；
//   这里看的是**该不该进疑似清单**（即该不该问用户）。
// 简称和英文裸全名都只能告警，不能自动脱敏 —— 误伤代价太高。
function runSuspectGroup (name, cases) {
  let pass = 0
  const fails = []
  for (const item of cases) {
    const [text, expect, note, fragment] = item
    const r = desensitize(text)
    // 判定：指定片段是否出现在疑似清单中
    const hit = fragment
      ? r.suspected.some((s) => s.text === fragment)
      : r.suspected.length > 0
    const ok = (expect === 'alert') === hit
    if (ok) pass++
    else fails.push({
      text,
      note,
      out: r.content,
      sus: r.suspected.map((s) => s.text)
    })
  }
  const total = cases.length
  const rate = ((pass / total) * 100).toFixed(1)
  console.log(
    (pass === total ? '✓' : '✗') + ' ' + name.padEnd(26) +
    ' ' + String(pass).padStart(3) + '/' + total +
    '  (' + rate + '%)'
  )
  return fails
}

// ---- 用户确认强制脱敏 ----
//
// 校验「一键脱敏」的完整闭环：
//   引擎告警 → 用户确认 → 片段回灌 → 引擎强制脱敏
function runConfirmedGroup (name, cases) {
  let pass = 0
  const fails = []
  for (const item of cases) {
    const [text, confirmed, expected, note] = item
    const r = desensitize(text, { confirmed })
    const ok = r.content === expected
    if (ok) pass++
    else fails.push({ text, note, out: r.content, expected })
  }
  const total = cases.length
  const rate = ((pass / total) * 100).toFixed(1)
  console.log(
    (pass === total ? '✓' : '✗') + ' ' + name.padEnd(26) +
    ' ' + String(pass).padStart(3) + '/' + total +
    '  (' + rate + '%)'
  )
  return fails
}

console.log()
allFails = allFails.concat(runSuspectGroup('疑似·院校简称', B.SUSPECT_INSTITUTION))
allFails = allFails.concat(runSuspectGroup('疑似·英文裸全名', B.SUSPECT_EN_NAME))
allFails = allFails.concat(runSuspectGroup('疑似·拼音姓名', B.SUSPECT_PINYIN_NAME))
allFails = allFails.concat(runConfirmedGroup('确认·强制脱敏回灌', B.CONFIRMED))

console.log()
console.log('-'.repeat(74))

const totalCases = B.POS_ORG.length + B.POS_CN_PERSON.length + B.POS_EN_PERSON.length +
  B.POS_EN_CASE.length + B.POS_CN_BARE.length + B.POS_IDENTIFIER.length +
  B.POS_PINYIN_NAME.length +
  B.NEG_LOOKS_LIKE_NAME.length + B.NEG_GENERIC.length + B.NEG_EN.length +
  B.NEG_IDENTIFIER.length + B.NEG_PINYIN_NAME.length +
  B.SUSPECT_INSTITUTION.length + B.SUSPECT_EN_NAME.length +
  B.SUSPECT_PINYIN_NAME.length + B.CONFIRMED.length
const passed = totalCases - allFails.length

console.log('总计: ' + passed + ' / ' + totalCases +
  '  (' + ((passed / totalCases) * 100).toFixed(1) + '%)')

if (allFails.length) {
  console.log()
  console.log('失败明细:')
  for (const f of allFails) {
    console.log('  「' + f.text + '」' + (f.note ? '  [' + f.note + ']' : ''))
    console.log('    -> ' + f.out)
    if (f.suspected && f.suspected.length) {
      console.log('    疑似: ' + f.suspected.map(function (s) { return s.text }).join(', '))
    }
  }
}

// ---- L3 告警的单独统计 ----
console.log()
console.log('-'.repeat(74))
console.log('L3 兜底告警验证（形态可疑但无线索 → 不自动替换，但要提示）')
console.log('-'.repeat(74))
const alertCases = [
  ['王小明', '纯姓名无任何上下文'],
  ['我们在这个王小明见过面', '有上下文但无线索词'],
  ['王小明让我很痛苦', '有线索 → 应自动脱敏，不告警']
]
for (const [text, note] of alertCases) {
  const r = desensitize(text)
  console.log('  「' + text + '」')
  console.log('    输出: ' + r.content)
  console.log('    告警: ' + (r.suspected.length
    ? r.suspected.map(function (s) { return s.text }).join(', ')
    : '（无）') + '   ' + note)
}

process.exit(allFails.length ? 1 : 0)
