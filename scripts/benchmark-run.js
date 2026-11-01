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
console.log()
allFails = allFails.concat(runGroup('负·形似姓名的普通词', B.NEG_LOOKS_LIKE_NAME, false))
allFails = allFails.concat(runGroup('负·泛称与固定搭配', B.NEG_GENERIC, false))
allFails = allFails.concat(runGroup('负·英文普通词', B.NEG_EN, false))
allFails = allFails.concat(runGroup('负·普通数字', B.NEG_IDENTIFIER, false))

console.log()
console.log('-'.repeat(74))

const totalCases = B.POS_ORG.length + B.POS_CN_PERSON.length + B.POS_EN_PERSON.length +
  B.POS_EN_CASE.length + B.POS_CN_BARE.length + B.POS_IDENTIFIER.length +
  B.NEG_LOOKS_LIKE_NAME.length + B.NEG_GENERIC.length + B.NEG_EN.length +
  B.NEG_IDENTIFIER.length
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
