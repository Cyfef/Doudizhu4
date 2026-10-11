/* 回合顺序回归：叫分必须与出牌一样按逆时针推进。 */
'use strict';

const Room = require('../server/room.js').Room;

let fail = 0;
const oldRandom = Math.random;

for (let starter = 0; starter < 4; starter++) {
  Math.random = function () { return (starter + 0.1) / 4; };
  const room = new Room({ config: { totalRounds: 1, playTimeout: 5 } });
  room.notify = function () {};
  room.setTimer = function () {};
  for (let seat = 0; seat < 4; seat++) room.addPlayer('玩家' + seat, seat === 0);
  room.round = 1;
  room.beginRound();

  const expected = [starter];
  while (expected.length < 4) expected.push(room.nextSeat(expected[expected.length - 1]));
  const actual = room.bidOrder;
  const pass = actual.join(',') === expected.join(',');
  console.log((pass ? '  ✓ ' : '  ✗ ') + '起始座位 ' + starter + '：' + actual.join(' → '));
  if (!pass) fail++;
}

Math.random = oldRandom;
console.log('\n结果：' + (4 - fail) + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
