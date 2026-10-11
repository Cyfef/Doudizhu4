/* “要不起”判断回归：整手牌中是否存在至少一种合法压制。 */
'use strict';
const Rules = require('../public/js/rules.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }
function hand(ranks) { return ranks.map((rank, i) => ({ id: 't' + i, rank: rank })); }
function info(ranks) { return Rules.analyze(hand(ranks)); }

ok(!Rules.canBeatWithHand(hand([3, 4, 5, 7]), info([8, 8])), '没有更大对子或炸弹时判定要不起');
ok(Rules.canBeatWithHand(hand([3, 3, 3, 3]), info([15, 15])), '普通牌再大也能被炸弹压制');
ok(Rules.canBeatWithHand(hand([9, 9, 4]), info([8, 8])), '更大的同型牌可以压制');
ok(!Rules.canBeatWithHand(hand([9, 9, 9, 4]), info([8, 8, 8, 7, 7])), '三带二缺少对子时判定要不起');
ok(Rules.canBeatWithHand(hand([5, 6, 7, 8, 9]), info([3, 4, 5, 6, 7])), '更大的等长顺子可以压制');
ok(!Rules.canBeatWithHand(hand([5, 6, 7, 8]), info([3, 4, 5, 6, 7])), '张数不足的顺子判定要不起');
ok(Rules.canBeatWithHand(hand([3, 3, 3, 3, 3]), info([15, 15, 15, 15])), '5 张炸弹可以压过任意 4 张炸弹');
ok(!Rules.canBeatWithHand(hand([15, 15, 15, 15]), info([3, 3, 3, 3, 3])), '4 张炸弹不能压过 5 张炸弹');
ok(Rules.canBeatWithHand(hand([16, 16, 17, 17]), info([15, 15, 15, 15, 15, 15, 15, 15])), '火箭可以压过 8 张炸弹');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
