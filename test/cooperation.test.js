/* 测试：农民协作策略 —— 不反炸队友，但允许低成本接队友小牌 */
'use strict';

const Bot = require('../server/bot.js');
const Rules = require('../public/js/rules.js');
const Room = require('../server/room.js').Room;

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }

function cards(ranks, prefix) {
  return ranks.map((r, i) => ({ rank: r, id: prefix + i, suit: i % 4 }));
}

function playInfo(ranks, seat) {
  const cs = cards(ranks, 'L');
  return { seat, cards: cs, info: Rules.analyze(cs) };
}

console.log('— 农民协作策略 —');
Bot.setUseNet(true);

{
  const hand = cards([3, 3, 3, 3, 10, 10, 10, 10, 14, 14, 15, 15, 16], 'H');
  const dec = Bot.choosePlay({
    hand,
    lastPlay: playInfo([9, 9, 9, 9], 1),
    mySeat: 2,
    landlordSeat: 0,
    isLandlord: false,
    counts: [18, 21, hand.length, 20],
    playedCounts: new Array(15).fill(0),
    consecutivePasses: 0
  });
  ok(dec && dec.pass, '队友农民出了炸弹时，即使手里有更大炸弹也不反炸');
}

{
  const hand = cards([4, 6, 8, 8, 10, 10, 10, 10, 15, 16], 'H');
  const dec = Bot.choosePlay({
    hand,
    lastPlay: playInfo([3], 1),
    mySeat: 2,
    landlordSeat: 0,
    isLandlord: false,
    counts: [18, 21, hand.length, 20],
    playedCounts: new Array(15).fill(0),
    consecutivePasses: 0
  });
  const got = dec && dec.cards ? dec.cards.map(c => c.rank).join(',') : 'pass';
  const info = dec && dec.cards ? Rules.analyze(dec.cards) : null;
  ok(info && info.type === 'single' && info.value > 3 && info.value < 15,
    '队友出小单张时，允许用低成本小牌接上跑牌（实际 ' + got + '）');
}

{
  const hand = cards([3, 3, 3, 3, 10, 10, 10, 10, 14, 14, 15, 15, 16], 'H');
  const dec = Bot.choosePlay({
    hand,
    lastPlay: playInfo([9, 9, 9, 9], 0),
    mySeat: 2,
    landlordSeat: 0,
    isLandlord: false,
    counts: [1, 21, hand.length, 20],
    playedCounts: new Array(15).fill(0),
    consecutivePasses: 0
  });
  ok(dec && dec.cards && Rules.analyze(dec.cards).type === 'bomb', '地主出了炸弹且只剩 1 张时，农民可以用炸弹拦截');
}

{
  const room = new Room({ name: '托管协作测试', config: { totalRounds: 1, playTimeout: 5 } });
  room.broadcast = function () {};
  room.addPlayer('地主', true);
  room.addPlayer('队友', false);
  room.addPlayer('托管农民', false);
  room.addPlayer('农民二', false);
  room.phase = 'playing';
  room.landlordSeat = 0;
  room.currentTurnSeat = 2;
  room.players[0].isLandlord = true;
  room.players[2].autoPlay = true;
  room.players[2].hand = cards([3, 3, 3, 3, 10, 10, 10, 10, 14, 14, 15, 15, 16], 'A');
  room.players[0].hand = cards([6, 7, 8], 'B');
  room.players[1].hand = cards([4, 5], 'C');
  room.players[3].hand = cards([9, 11], 'D');
  room.lastPlay = playInfo([9, 9, 9, 9], 1);
  room.lastPlaySeat = 1;
  room.passCount = 0;
  room.history = [];
  room.playedCounts = new Array(15).fill(0);
  room.bombMult = 1;
  room.farmerPlayedCount = 0;
  room.landlordPlayCount = 0;
  const dec = room.recommendPlayForSeat(2);
  room.botPlay(2);
  ok(dec && dec.pass, '真人托管也沿用协作模型：队友炸弹后推荐过牌');
  ok(room.passEvents.length === 1 && room.players[2].hand.length === 13, '真人托管实际执行时没有反炸队友');
}

console.log('— 炸弹使用与拆炸软约束 —');

{
  const hand = cards([3, 3, 3, 3, 6, 6, 9, 9, 12, 12, 14, 14], 'Z');
  const dec = Bot.choosePlay({
    hand,
    lastPlay: playInfo([5, 5], 0),
    mySeat: 1,
    landlordSeat: 0,
    isLandlord: false,
    counts: [18, hand.length, 20, 20],
    playedCounts: new Array(15).fill(0),
    consecutivePasses: 0
  });
  const info = dec && dec.cards ? Rules.analyze(dec.cards) : null;
  ok(info && info.type === 'pair' && info.value === 6,
    '对手出小对子且有普通对子能压时，不粗暴使用炸弹（实际 ' + (info ? info.type + ':' + info.value : 'pass') + '）');
}

{
  const hand = cards([3, 3, 3, 3, 7, 7, 10, 11], 'B');
  const moves = Bot.genMoves(hand, null);
  const cands = Bot.filterStrategicCandidates({
    hand,
    lastPlay: null,
    mySeat: 1,
    landlordSeat: 0,
    isLandlord: false,
    counts: [18, hand.length, 20, 20]
  }, moves);
  const bad = cands.some(m => !m.pass && m.info.type === 'triple_pair' && m.cards.some(c => c.rank === 3));
  ok(!bad, '自由出牌时有普通打法则不把炸弹拆成三带二');
}

{
  const hand = cards([3, 3, 3, 3, 7, 7], 'C');
  const moves = Bot.genMoves(hand, null);
  const cands = Bot.filterStrategicCandidates({
    hand,
    lastPlay: null,
    mySeat: 1,
    landlordSeat: 0,
    isLandlord: false,
    counts: [18, hand.length, 20, 20]
  }, moves);
  const okBreak = cands.some(m => !m.pass && m.info.type === 'triple_pair' && m.cards.length === hand.length - 1);
  ok(okBreak, '接近收尾时仍允许拆炸形成高收益牌型');
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
