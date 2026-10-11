/* 测试：已部署人机模型的房间集成 —— 验证不违法、不卡死、记牌上下文正确
 */
'use strict';
process.env.ROOM_DATA_DIR = require('path').join(require('os').tmpdir(), 'ddz-test-netbot');
const RoomModule = require('../server/room.js');
const Room = RoomModule.Room;
const Bot = require('../server/bot.js');
const Rules = require('../public/js/rules.js');
const Cards = require('../public/js/cards.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }
function eq(a, b, m) { ok(a === b, m + '  (实际: ' + JSON.stringify(a) + ')'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function main() {
  console.log('— 前置：网络策略确实开着 —');
  ok(Bot.usingNet(), 'bot.js 正在使用已部署人机模型（usingNet=true）');
  if (!Bot.usingNet()) {
    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(1);
  }

  // ============ 1. 四机自对弈（进程内，含记牌上下文） ============
  console.log('— 四机自对弈（网络策略，含「全场已出牌」记牌特征）—');
  function playGame() {
    const d = Cards.deal();
    const hands = d.hands.map(h => h.slice());
    const counts = [25, 25, 25, 25];
    let highest = 0, landlord = -1;
    for (let s = 0; s < 4; s++) {
      const v = Bot.chooseBid(hands[s], highest);
      if (v > 0) { highest = v; landlord = s; }
      if (v === 3) break;
    }
    if (landlord < 0) return { aborted: true };
    hands[landlord] = hands[landlord].concat(d.bottom);
    counts[landlord] = 33;
    const isLL = [false, false, false, false]; isLL[landlord] = true;
    const playedCounts = new Array(15).fill(0);   // 记牌：全场已出牌

    let turn = landlord, lastPlay = null, lastSeat = -1, passCount = 0, steps = 0, maxCands = 0;
    while (steps++ < 3000) {
      const hand = hands[turn];
      const dec = Bot.choosePlay({
        hand, lastPlay, mySeat: turn, landlordSeat: landlord,
        isLandlord: isLL[turn], counts, playedCounts
      });
      if (dec.cards && dec.cards.length) {
        const info = Rules.analyze(dec.cards);
        if (!info) throw new Error('网络人机给出非法牌型: ' + dec.cards.map(c => c.rank).join(','));
        if (lastPlay && !Rules.beats(info, lastPlay.info)) throw new Error('网络人机给出压不过的牌');
        const ids = {}; dec.cards.forEach(c => ids[c.id] = 1);
        const before = hand.length;
        for (let i = hand.length - 1; i >= 0; i--) if (ids[hand[i].id]) hand.splice(i, 1);
        if (hand.length !== before - dec.cards.length) throw new Error('扣牌数量不对');
        counts[turn] = hand.length;
        dec.cards.forEach(c => playedCounts[c.rank - 3]++);
        lastPlay = { seat: turn, cards: dec.cards, info }; lastSeat = turn; passCount = 0;
        if (hand.length === 0) return { winner: turn, steps, landlord };
      } else {
        if (!lastPlay) throw new Error('首出竟然过牌');
        passCount++;
        if (passCount >= 3) { turn = lastSeat; lastPlay = null; passCount = 0; continue; }
      }
      turn = (turn + 1) % 4;
    }
    return { timeout: true, steps };
  }

  const N = 100;
  let llWin = 0, farmerWin = 0, timeouts = 0, aborts = 0, totSteps = 0;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const r = playGame();
    if (r.aborted) { aborts++; continue; }
    if (r.timeout) { timeouts++; continue; }
    totSteps += r.steps;
    if (r.winner === r.landlord) llWin++; else farmerWin++;
  }
  const perDec = (Date.now() - t0) / Math.max(1, totSteps);
  eq(timeouts, 0, '没有对局卡死（' + N + ' 局，流局 ' + aborts + '，正常结束 ' + (llWin + farmerWin) + '）');
  ok(llWin > 0 && farmerWin > 0, '地主与农民都有胜局（地主 ' + llWin + ' / 农民 ' + farmerWin
    + '，平均 ' + (totSteps / Math.max(1, llWin + farmerWin)).toFixed(0) + ' 步/局）');
  console.log('    四家全网络自对弈：地主胜率 ' + (llWin / Math.max(1, llWin + farmerWin) * 100).toFixed(1)
    + '%（启发式自对弈是 48.7%，仅供对照）');
  console.log('    单决策耗时 ≈ ' + perDec.toFixed(2) + ' ms（人机思考延时 0.8~1.9s，完全够用）');
  ok(perDec < 100, '单决策耗时远小于人机思考延时（' + perDec.toFixed(2) + ' ms < 800ms）');

  // ============ 2. 真实房间：记牌接线 + 不被规则拒绝 ============
  console.log('— 真实房间（3 人机 + 1 自动真人）—');
  const errs = [];
  const origErr = console.error;
  console.error = function () { errs.push(Array.prototype.join.call(arguments, ' ')); };

  const room = new Room({ name: '模型测试房', config: { totalRounds: 1, playTimeout: 5 } });
  room.broadcast = function () {};
  room.botThinkDelay = function () { return 1; };
  room.addPlayer('我', true);
  room.addBot(1); room.addBot(2); room.addBot(3);
  room.start();

  let invariantBad = 0, checks = 0;
  for (let i = 0; i < 6000; i++) {
    await sleep(2);
    if (room.phase === 'roomEnd' || room.paused) break;
    // 记牌不变量：任意时刻 各家手牌之和 + 已出牌之和 == 108
    if (room.phase === 'playing') {
      let hs = 0;
      for (let s = 0; s < 4; s++) if (room.players[s]) hs += room.players[s].hand.length;
      const ps = room.playedCounts.reduce((a, b) => a + b, 0);
      checks++;
      if (hs + ps !== 108) invariantBad++;
    }
    if (room.phase === 'bidding') {
      const s = room.bidOrder[room.bidIndex];
      const p = room.players[s];
      if (p && !p.isBot) room.submitBid(s, 0);
    } else if (room.phase === 'reveal') {
      if (!room.players[room.landlordSeat].isBot) room.submitReveal(room.landlordSeat, false);
    } else if (room.phase === 'multiply') {
      for (let s = 0; s < 4; s++) {
        const p = room.players[s];
        if (p && !p.isBot && room.multiplyChoices[s] == null) room.submitMultiply(s, 1);
      }
    } else if (room.phase === 'playing') {
      const s = room.currentTurnSeat;
      const p = room.players[s];
      if (p && !p.isBot) {
        if (room.lastPlay == null) {
          const min = p.hand.slice().sort((a, b) => a.rank - b.rank)[0];
          room.submitPlay(s, [min.id]);
        } else room.submitPass(s);
      }
    }
  }
  console.error = origErr;

  eq(room.phase, 'roomEnd', '真实房间跑到了结算结束（roomEnd）');
  const rejected = errs.filter(e => /bot play rejected|bot choosePlay error|bot action error/.test(e));
  eq(rejected.length, 0, '人机的每一次决策都被服务端规则接受（0 次被拒）'
    + (rejected.length ? '：' + rejected.slice(0, 2).join(' | ') : ''));
  ok(checks > 0, '出牌阶段被观测到（' + checks + ' 次采样）');
  eq(invariantBad, 0, '记牌不变量成立：Σ手牌 + Σ已出牌 == 108（' + checks + ' 次采样）');

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
