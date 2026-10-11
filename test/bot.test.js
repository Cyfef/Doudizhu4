/* 测试：人机引擎 —— 枚举完备性（对拍暴力枚举）/ 牌力分布校准 / 四机对局冒烟 */
'use strict';
const Rules = require('../public/js/rules.js');
const Cards = require('../public/js/cards.js');
const Bot = require('../server/bot.js');
// 本文件测的是「启发式引擎」本体（枚举完备性 / 牌力分位 / 阈值 / 冒烟），
// 关掉 Coop-Bomb-v1 的网络策略：既能对齐原有语义与耗时，也避免这里没传 playedCounts 导致记牌特征为零。
// 已部署模型的房间集成测试见 test/model-bot.test.js。
Bot.setUseNet(false);

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }
function eq(a, b, m) { ok(a === b, m + '  (实际: ' + JSON.stringify(a) + ')'); }

// 等价类键：同点数的不同花色是等价的（枚举器每个「点数方案」只挑一组代表牌）
function key(cards) { return cards.map(c => c.rank).sort((a, b) => a - b).join(','); }

// ---------------- 1. 枚举完备性：12 张手牌 vs 暴力枚举全部子集 ----------------
console.log('— 枚举完备性（暴力对拍） —');
let mism = 0, totalLegal = 0, trials = 0;
for (let t = 0; t < 60; t++) {
  const deck = Cards.shuffle(Cards.buildDeck());
  const hand = deck.slice(0, 12);           // 12 张 → 2^12 = 4096 个子集
  const mine = new Set(Bot.genMoves(hand, null).map(m => key(m.cards)));
  const brute = new Set();
  for (let mask = 1; mask < (1 << 12); mask++) {
    const sub = [];
    for (let b = 0; b < 12; b++) if (mask & (1 << b)) sub.push(hand[b]);
    if (Rules.analyze(sub)) brute.add(key(sub));
  }
  totalLegal += brute.size;
  for (const k2 of brute) if (!mine.has(k2)) { mism++; if (mism <= 2) console.log('    漏掉: ' + k2); }
  trials++;
}
eq(mism, 0, '枚举器没有漏掉任何合法牌型（对拍 ' + trials + ' 副手牌 / ' + totalLegal + ' 个合法出法）');

// 反向：枚举出来的必须都合法（genMoves 内部已用 analyze 校验）
let illegal = 0;
for (let t = 0; t < 200; t++) {
  const hand = Cards.shuffle(Cards.buildDeck()).slice(0, 25);
  for (const m of Bot.genMoves(hand, null)) if (!Rules.analyze(m.cards)) illegal++;
}
eq(illegal, 0, '枚举器产出的每一个出法都通过权威规则校验');

// 跟牌枚举：只返回能压过的
let badFollow = 0;
for (let t = 0; t < 200; t++) {
  const deck = Cards.shuffle(Cards.buildDeck());
  const hand = deck.slice(0, 20);
  const lead = deck.slice(20, 22);                  // 随便拿两张当上一手（可能非法，跳过）
  const li = Rules.analyze(lead);
  if (!li) continue;
  for (const m of Bot.genMoves(hand, li)) if (!Rules.beats(m.info, li)) badFollow++;
}
eq(badFollow, 0, '跟牌枚举只包含能压过上家的出法');

// 规模：地主 33 张手牌的最多候选数
let maxMoves = 0, sumMoves = 0, n = 0;
for (let t = 0; t < 300; t++) {
  const d = Cards.deal();
  const ll = d.hands[0].concat(d.bottom);
  const c = Bot.genMoves(ll, null).length;
  maxMoves = Math.max(maxMoves, c); sumMoves += c; n++;
}
console.log('    地主(33张) 领出候选：平均 ' + (sumMoves / n).toFixed(1) + '，最多 ' + maxMoves);

// ---------------- 2. 单张王是合法牌型（曾经的死锁坑） ----------------
console.log('— 单张王 —');
const jokers = Cards.buildDeck().filter(c => c.rank >= 16);
const jMoves = Bot.genMoves(jokers, null);
ok(jMoves.some(m => m.info.type === 'single'), '单张王被识别为合法单张');
ok(jMoves.some(m => m.info.type === 'rocket'), '四张王被识别为火箭');

// ---------------- 3. 牌力分布校验（阈值应落在设计的位置） ----------------
console.log('— 牌力分布与阈值命中率 —');
const farmer = [], big = [];
for (let t = 0; t < 4000; t++) {
  const d = Cards.deal();
  farmer.push(Bot.powerOf(d.hands[0]));
  big.push(Bot.powerOf(d.hands[0].concat(d.bottom)));
}
function stat(a, name) {
  a.sort((x, y) => x - y);
  const q = p => a[Math.floor(p * (a.length - 1))];
  console.log('    ' + name + '  p25=' + q(.25).toFixed(1) + ' p50=' + q(.50).toFixed(1)
    + ' p75=' + q(.75).toFixed(1) + ' p90=' + q(.90).toFixed(1) + ' p95=' + q(.95).toFixed(1));
  return q;
}
const qf = stat(farmer, '农民(25张)');
const qb = stat(big, '地主(33张)');
function rate(a, th) { return (a.filter(v => v >= th).length / a.length * 100).toFixed(0); }
console.log('    叫分意愿: 会叫3分 ' + rate(farmer, Bot.thresholds.bid.three) + '%'
  + ' · ≥2分 ' + rate(farmer, Bot.thresholds.bid.two) + '%'
  + ' · ≥1分 ' + rate(farmer, Bot.thresholds.bid.one) + '%');
console.log('    加倍意愿: 地主 超倍 ' + rate(big, Bot.thresholds.big.mult4) + '% / 加倍 ' + rate(big, Bot.thresholds.big.mult2) + '%'
  + ' · 农民 超倍 ' + rate(farmer, Bot.thresholds.small.mult4) + '% / 加倍 ' + rate(farmer, Bot.thresholds.small.mult2) + '%');
console.log('    明牌意愿(仅地主): ' + rate(big, Bot.thresholds.big.reveal) + '%');
ok(Math.abs(qf(.5) - Bot.thresholds.bid.one) <= 3, '「叫 1 分」阈值贴近农民手牌中位数（中位分 ' + qf(.5).toFixed(1) + ' vs 阈值 ' + Bot.thresholds.bid.one + '）');
ok(qf(.5) < Bot.thresholds.bid.three && Bot.thresholds.bid.three < qf(.95), '「叫 3 分」阈值落在高分位区间（p50~p95 之间）');
ok(qb(.5) < Bot.thresholds.big.mult2 && Bot.thresholds.big.mult2 < qb(.90), '地主「加倍」阈值落在高分位区间');
ok(qb(.5) < Bot.thresholds.big.reveal && Bot.thresholds.big.reveal < qb(.95), '地主「明牌」阈值落在高分位区间');
// 发不出牌要能叫分：不能出现「人人都不叫」成常态
let noBid = 0;
for (let t = 0; t < 2000; t++) {
  const d = Cards.deal();
  let h = 0, landlord = -1;
  for (const s of [0, 1, 2, 3]) {
    const v = Bot.chooseBid(d.hands[s], h);
    if (v > 0) { h = v; landlord = s; }
    if (v === 3) break;
  }
  if (landlord < 0) noBid++;
}
console.log('    流局率（4 家都不叫）: ' + (noBid / 2000 * 100).toFixed(1) + '%');
ok(noBid / 2000 < 0.20, '流局率不过高（' + (noBid / 2000 * 100).toFixed(1) + '% < 20%），牌局不会老是重发');

// ---------------- 3.5 叫分/加倍/出牌接口一致性 ----------------
console.log('— 决策接口 —');
{
  const d = Cards.deal();
  const h = d.hands[0];
  let bidOk = true;
  for (let i = 0; i < 200; i++) {
    const v = Bot.chooseBid(h, 2);
    if (!(v === 0 || v === 3)) bidOk = false;      // 已有人叫 2 分时只能不叫或叫 3 分
  }
  ok(bidOk, '叫分结果要么 0 要么高于当前最高分（不会返回压不过的分）');
  let mv = [Bot.chooseMultiply(h), Bot.chooseMultiply(d.hands[0].concat(d.bottom))];
  ok(mv.every(v => v === 1 || v === 2 || v === 4), '加倍只返回 1 / 2 / 4');
  ok(Bot.chooseReveal(h) === false, '农民（25 张）不会被判为明牌');
}

// ---------------- 4. 四机整局冒烟（含叫分/加倍/出牌，检查不崩不死锁） ----------------
console.log('— 四机对局冒烟 —');
function playBotGame() {
  const d = Cards.deal();
  const hands = d.hands.map(h => h.slice());
  const counts = [25, 25, 25, 25];
  // 叫分
  let highest = 0, landlord = -1;
  const order = [0, 1, 2, 3];
  for (const s of order) {
    const v = Bot.chooseBid(hands[s], highest);
    if (v > 0) { highest = v; landlord = s; }
    if (v === 3) break;
  }
  if (landlord < 0) return { aborted: true };
  hands[landlord] = hands[landlord].concat(d.bottom);
  counts[landlord] = 33;
  const isLL = [false, false, false, false]; isLL[landlord] = true;
  const reveal = Bot.chooseReveal(hands[landlord]);
  const mults = [1, 1, 1, 1];
  for (let s = 0; s < 4; s++) mults[s] = Bot.chooseMultiply(hands[s]);
  void reveal; void mults;

  let turn = landlord, lastPlay = null, lastSeat = -1, passCount = 0, steps = 0;
  while (steps++ < 3000) {
    const hand = hands[turn];
    const dec = Bot.choosePlay({
      hand, lastPlay, mySeat: turn, landlordSeat: landlord,
      isLandlord: isLL[turn], counts
    });
    if (dec.cards && dec.cards.length) {
      const info = Rules.analyze(dec.cards);
      if (!info) throw new Error('人机给出了非法牌型: ' + JSON.stringify(dec.cards.map(c => c.rank)));
      if (lastPlay && !Rules.beats(info, lastPlay.info)) throw new Error('人机给出了压不过的牌');
      if (dec.cards.length > hand.length) throw new Error('人机出的牌比手牌还多');
      const ids = {}; dec.cards.forEach(c => ids[c.id] = 1);
      const before = hand.length;
      for (let i = hand.length - 1; i >= 0; i--) if (ids[hand[i].id]) hand.splice(i, 1);
      if (hand.length !== before - dec.cards.length) throw new Error('扣牌数量不对');
      counts[turn] = hand.length;
      lastPlay = { seat: turn, cards: dec.cards, info }; lastSeat = turn; passCount = 0;
      if (hand.length === 0) return { winner: turn, steps, landlord, farmerSteps: null };
    } else {
      if (!lastPlay) throw new Error('首出竟然过牌');
      passCount++;
      if (passCount >= 3) { turn = lastSeat; lastPlay = null; passCount = 0; continue; }
    }
    turn = (turn + 1) % 4;
  }
  return { timeout: true, steps };
}
let llWin = 0, farmerWin = 0, timeouts = 0, aborts = 0, totSteps = 0;
const N = 600;
for (let i = 0; i < N; i++) {
  const r = playBotGame();
  if (r.aborted) { aborts++; continue; }
  if (r.timeout) { timeouts++; continue; }
  totSteps += r.steps;
  if (r.winner === r.landlord) llWin++; else farmerWin++;
}
eq(timeouts, 0, '没有对局卡死（' + N + ' 局，流局 ' + aborts + '，正常结束 ' + (llWin + farmerWin) + '）');
ok(llWin > 0 && farmerWin > 0, '地主与农民都有胜局（地主 ' + llWin + ' / 农民 ' + farmerWin + '，平均 ' + (totSteps / (llWin + farmerWin)).toFixed(0) + ' 步/局）');
console.log('    地主胜率 ' + (llWin / (llWin + farmerWin) * 100).toFixed(1) + '%（1 打 3 局、偏置发牌，这个数只作参考）');

// ---------------- 5. 决策耗时 ----------------
const d5 = Cards.deal();
const h5 = d5.hands[0].concat(d5.bottom);
const t0 = Date.now();
for (let i = 0; i < 2000; i++) Bot.choosePlay({ hand: h5, lastPlay: null, mySeat: 0, landlordSeat: 0, isLandlord: true, counts: [33, 25, 25, 25] });
console.log('    领出决策耗时 ≈ ' + ((Date.now() - t0) / 2000).toFixed(2) + ' ms/次（人机思考延时是 0.8~1.9s，完全够用）');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
