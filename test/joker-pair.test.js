const Rules = require('../public/js/rules.js');
const Bot = require('../server/bot.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}
function cards(ranks) { return ranks.map((rank, i) => ({ id: 'j' + i, rank })); }

console.log('— 同色双王对子 —');
const small = Rules.analyze(cards([16, 16]));
const big = Rules.analyze(cards([17, 17]));
ok(small && small.type === 'pair' && small.value === 16, '两个小王识别为对子');
ok(big && big.type === 'pair' && big.value === 17, '两个大王识别为对子');
ok(Rules.analyze(cards([16, 17])) === null, '一大王一小王不能组成对子');
ok(Rules.beats(big, small), '对大王可以压对小王');
ok(!Rules.beats(small, big), '对小王不能压对大王');
ok(Rules.canBeatWithHand(cards([16, 16]), Rules.analyze(cards([15, 15]))), '对小王可以压普通对子');
const moves = Bot.genMoves(cards([16, 16, 17, 17]), null);
ok(moves.some(m => m.info.type === 'pair' && m.info.value === 16), '机器人会枚举对小王');
ok(moves.some(m => m.info.type === 'pair' && m.info.value === 17), '机器人会枚举对大王');

console.log('— 飞机带王对子 —');
const planeSmallAndPair = Rules.analyze(cards([3, 3, 3, 4, 4, 4, 8, 8, 16, 16]));
const planeTwoJokerPairs = Rules.analyze(cards([3, 3, 3, 4, 4, 4, 16, 16, 17, 17]));
ok(planeSmallAndPair && planeSmallAndPair.type === 'airplane_pair', '飞机可带一对小王和一个普通对子');
ok(planeTwoJokerPairs && planeTwoJokerPairs.type === 'airplane_pair', '飞机可同时带一对小王和一对大王');
ok(Rules.analyze(cards([3, 3, 3, 4, 4, 4, 8, 8, 16, 17])) === null,
  '一大王一小王混搭不能作为飞机翼对子');
const planeMoves = Bot.genMoves(cards([3, 3, 3, 4, 4, 4, 16, 16, 17, 17]), null);
ok(planeMoves.some(m => m.info.type === 'airplane_pair' && m.cards.length === 10),
  '机器人会枚举带两对王的飞机');

console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
