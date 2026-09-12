/*
 * test.js — Node 自检脚本（无需浏览器）
 * 校验：题库完整性、评分归一化、并列处理、六种类型可触发、修改答案不重复累计。
 * 运行：node test.js
 */
'use strict';

global.DATA = require('./data.js');
var engine = require('./app.js');
var DATA = global.DATA;

var pass = 0;
var fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  -> ' + extra : ''));
  }
}

console.log('\n=== 1. 题库与配置完整性 ===');
ok('题目数量为 20', DATA.questions.length === 20);
var allOptValid = DATA.questions.every(function (q) {
  return q.options.length === 4 && q.options.every(function (o) {
    return ['B', 'F', 'C', 'R', 'S', 'N'].indexOf(o.type) >= 0;
  });
});
ok('每题 4 个选项且类型合法', allOptValid);

// maxScore 由各类型机会数 × 每题分值 推导，应与题库一致
var opp = { B: 0, F: 0, C: 0, R: 0, S: 0, N: 0 };
DATA.questions.forEach(function (q) {
  q.options.forEach(function (o) {
    opp[o.type]++;
  });
});
var ms = engine.getMaxScores();
var derivedOk = Object.keys(opp).every(function (t) {
  return ms[t] === opp[t] * DATA.scoring.perOption;
});
ok('maxScore 由题库机会数推导且一致', derivedOk, JSON.stringify(ms));

console.log('\n=== 2. 六种类型均可作为主类型被触发 ===');
['B', 'F', 'C', 'R', 'S', 'N'].forEach(function (target) {
  var answers = {};
  DATA.questions.forEach(function (q, i) {
    var opt = q.options.filter(function (o) {
      return o.type === target;
    })[0];
    if (opt) answers[i] = target;
  });
  var r = engine.resolveResult(answers);
  ok(target + ' 型可成为主类型', r.primary === target, 'primary=' + r.primary);
});

console.log('\n=== 3. 归一化排序（非 rawScore 直接排序）===');
// B 只选 1 题(原始2)，R 选满(原始28) -> 明显 R 在前；同时验证 normalized 计算正确
var a2 = { 0: 'B' }; // B raw=2 -> norm=2/28
a2[1] = 'R'; a2[3] = 'R'; a2[4] = 'R'; a2[6] = 'R'; a2[7] = 'R';
a2[9] = 'R'; a2[10] = 'R'; a2[12] = 'R'; a2[13] = 'R'; a2[14] = 'R';
a2[15] = 'R'; a2[16] = 'R'; a2[18] = 'R'; a2[19] = 'R';
var r2 = engine.resolveResult(a2);
ok('R 归一化分最高', r2.primary === 'R', 'primary=' + r2.primary);
ok(
  'B 归一化分 = 2/28 ≈ 0.0714',
  Math.abs(r2.norm.B - 2 / 28) < 1e-9,
  'norm.B=' + r2.norm.B
);

console.log('\n=== 4. 并列处理：末5题破平（F vs C）===');
// 全选 F 与全选 C -> 两者 norm 均为 1.0，末5题中 F 出现更多 -> F 为主
var tieA = {};
DATA.questions.forEach(function (q, i) {
  var fo = q.options.filter(function (o) { return o.type === 'F'; })[0];
  var co = q.options.filter(function (o) { return o.type === 'C'; })[0];
  if (fo) tieA[i] = 'F';
  else if (co) tieA[i] = 'C';
});
var rTieA = engine.resolveResult(tieA);
ok('F/C 并列时主类型=F（末5题破平）', rTieA.primary === 'F', 'primary=' + rTieA.primary);
ok('F/C 并列未被误判为双核心', rTieA.isTie === false);

console.log('\n=== 5. 并列处理：末5题仍相同 -> 双核心型 ===');
// B 与 R 在 9 道题上重叠，无法同时满分，故用随机搜索找一组真实可触发的
// “首=副归一化分 且 末5题并列次数相同” 输入（仅用于测试，不参与结果选择）。
function findDoubleCore() {
  var types = ['B', 'F', 'C', 'R', 'S', 'N'];
  for (var iter = 0; iter < 400000; iter++) {
    var ans = {};
    DATA.questions.forEach(function (q, i) {
      var o = q.options[Math.floor(Math.random() * q.options.length)];
      ans[i] = o.type;
    });
    var r = engine.resolveResult(ans);
    if (r.isTie && r.tieTypes && r.tieTypes.length === 2) return { result: r, answers: ans };
  }
  return null;
}
var dc = findDoubleCore();
ok('能构造出双核心型(isTie=true)', !!dc, dc ? dc.result.tieTypes.join('×') : '未找到');
if (dc) {
  var r = dc.result;
  ok(
    '双核心型首=副归一化分',
    Math.abs(r.norm[r.tieTypes[0]] - r.norm[r.tieTypes[1]]) < 1e-9
  );
  // 严禁 random 决定结果：tieTypes 必须由末5题次数推导，且两者末5题次数相等
  var last5 = DATA.scoring.lastFiveTiebreak;
  var c0 = 0, c1 = 0;
  last5.forEach(function (i) {
    if (dc.answers[i] === r.tieTypes[0]) c0++;
    if (dc.answers[i] === r.tieTypes[1]) c1++;
  });
  ok('双核心型末5题次数相等(非随机)', c0 === c1, c0 + ' vs ' + c1);
}

console.log('\n=== 6. 修改答案不重复累计 ===');
// 先选 B 再改为 F，raw 不应把 B 留下
var mod = { 0: 'B' };
mod[0] = 'F'; // 覆盖
var rMod = engine.resolveResult(mod);
ok('修改后 B 原始分=0', rMod.raw.B === 0, 'raw.B=' + rMod.raw.B);
ok('修改后 F 原始分=2', rMod.raw.F === 2, 'raw.F=' + rMod.raw.F);

console.log('\n=== 7. 20 题可全部完成（答案可映射满 20 题）===');
var full = {};
DATA.questions.forEach(function (q, i) {
  full[i] = q.options[0].type;
});
var rFull = engine.resolveResult(full);
ok('完整 20 题可计算', rFull.sorted.length === 6 && rFull.primary);

console.log('\n----------------------------------------');
console.log('通过: ' + pass + '   失败: ' + fail);
console.log('----------------------------------------\n');
process.exit(fail === 0 ? 0 : 1);
