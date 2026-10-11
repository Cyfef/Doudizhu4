/* 测试：多阶段随机发牌 —— 初始炸弹计划 + 余牌自然长炸/新炸 */
'use strict';
const Cards = require('../public/js/cards.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }
function counts(cards) {
  const out = {};
  cards.forEach(c => out[c.rank] = (out[c.rank] || 0) + 1);
  return out;
}
function ordinaryBombs(hand) {
  const c = counts(hand);
  return Object.keys(c).filter(r => +r <= 15 && c[r] >= 4).map(r => ({ rank: +r, size: c[r] }));
}
function hasRocket(hand) {
  const c = counts(hand);
  return (c[16] || 0) === 2 && (c[17] || 0) === 2;
}

const N = 8000;
const T = Cards.BOMB_TARGET;
const raw = Cards.randomDeal();
ok(raw.hands.length === 4 && raw.hands.every(h => h.length === 25) && raw.bottom.length === 8,
  '完全随机模式保持四家各 25 张、底牌 8 张');

let sizeBad = 0, uniqueBad = 0, fallback = 0, planBad = 0, rocketBad = 0, rangeBad = 0;
let plannedTotal = 0, plannedSq = 0, actualTotal = 0, rockets = 0;
let grewGames = 0, extendedBombs = 0, newBombs = 0;
let bottomWithJoker = 0, bottomWithPair = 0, bottomWithBomb = 0;
const plannedSizes = { 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };
const actualSizes = { 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };

const started = Date.now();
for (let game = 0; game < N; game++) {
  const d = Cards.deal();
  if (d.meta.fallback) { fallback++; continue; }
  const all = d.hands.concat([d.bottom]);
  if (d.hands.some(h => h.length !== 25) || d.bottom.length !== 8
    || all.reduce((n, h) => n + h.length, 0) !== 108) sizeBad++;
  const ids = new Set(); all.forEach(h => h.forEach(c => ids.add(c.id)));
  if (ids.size !== 108) uniqueBad++;

  const actualBySeat = d.hands.map(ordinaryBombs);
  const actualCount = actualBySeat.reduce((n, list) => n + list.length, 0);
  actualTotal += actualCount;
  if (actualCount > d.meta.plannedOrdinaryBombs) grewGames++;
  const actualMap = actualBySeat.map(list => {
    const m = {}; list.forEach(b => { m[b.rank] = b.size; actualSizes[b.size]++; }); return m;
  });
  const plannedMap = [{}, {}, {}, {}];
  (d.meta.plannedBombs || []).forEach(b => {
    plannedMap[b.owner][b.rank] = b.size;
    plannedSizes[b.size]++;
    const got = actualMap[b.owner][b.rank] || 0;
    if (got < b.size) planBad++;
    if (got > b.size) extendedBombs++;
  });
  for (let seat = 0; seat < 4; seat++) {
    actualBySeat[seat].forEach(b => { if (!plannedMap[seat][b.rank]) newBombs++; });
  }

  const rocketSeats = d.hands.filter(hasRocket).length;
  if (rocketSeats !== (d.meta.rocket ? 1 : 0)) rocketBad++;
  if (!d.meta.rocket && d.hands.some(h => hasRocket(h.concat(d.bottom)))) rocketBad++;
  if (d.meta.rocket) rockets++;
  const planned = d.meta.plannedOrdinaryBombs;
  plannedTotal += planned; plannedSq += planned * planned;
  if (planned < T.min || planned > T.max) rangeBad++;

  const bc = counts(d.bottom);
  if ((bc[16] || 0) + (bc[17] || 0) > 0) bottomWithJoker++;
  if (Object.keys(bc).some(r => bc[r] >= 2)) bottomWithPair++;
  if (Object.keys(bc).some(r => +r <= 15 && bc[r] >= 4)) bottomWithBomb++;
}

const mean = plannedTotal / N;
const sd = Math.sqrt(plannedSq / N - mean * mean);
const plannedAll = Object.values(plannedSizes).reduce((a, b) => a + b, 0);
function pct(size) { return plannedSizes[size] / plannedAll * 100; }

console.log('— 张数守恒与初始炸弹计划（' + N + ' 局） —');
ok(sizeBad === 0, '每局四家各 25 张、底牌 8 张');
ok(uniqueBad === 0, '108 张牌始终唯一');
ok(fallback === 0, '没有触发完全随机兜底');
ok(planBad === 0, '初始规划的每个炸弹在补牌后都仍然存在');
ok(rocketBad === 0, '火箭严格服从独立的 5% 判定');
ok(rangeBad === 0, '规划炸弹数始终在 [' + T.min + ', ' + T.max + ']');
ok(Math.abs(mean - 10) <= 0.15, '规划炸弹数均值贴近 10（' + mean.toFixed(2) + '）');
ok(sd >= 0.85 && sd <= 1.15, '规划炸弹数标准差贴近 1（' + sd.toFixed(2) + '）');
ok(Math.abs(rockets / N - 0.05) <= 0.012, '火箭概率贴近 5%（' + (rockets / N * 100).toFixed(2) + '%）');

console.log('— 初始炸弹张数概率 —');
console.log('    ' + Object.keys(plannedSizes).map(k => k + '张=' + pct(k).toFixed(2) + '%').join('  '));
ok(Math.abs(pct(4) - 80) <= 1.2, '4 张炸弹初始概率贴近 80%');
const expectedSizePct = { 5: 14, 6: 3, 7: 2, 8: 1 };
const sizeTolerance = { 5: 1.0, 6: 0.55, 7: 0.45, 8: 0.35 };
[5, 6, 7, 8].forEach(k => ok(Math.abs(pct(k) - expectedSizePct[k]) <= sizeTolerance[k],
  k + ' 张炸弹初始概率贴近 ' + expectedSizePct[k] + '%'));

console.log('— 余牌自然增长 —');
console.log('    计划均值=' + mean.toFixed(2) + '，实际均值=' + (actualTotal / N).toFixed(2)
  + '；发生增长的局=' + grewGames + '；长炸=' + extendedBombs + '；新增炸弹=' + newBombs);
console.log('    实际类别：' + Object.keys(actualSizes).map(k => k + '张=' + actualSizes[k]).join('  '));
ok(grewGames > N * 0.2, '补余牌后有相当一部分牌局自然增加炸弹');
ok(extendedBombs > 0, '余牌能够让初始炸弹张数增加');
ok(newBombs > 0, '余牌能够自然形成初始计划外的新炸弹');

console.log('— 自然底牌 —');
ok(bottomWithJoker > N * 0.15, '底牌可以出现王');
ok(bottomWithPair > N * 0.5, '底牌可以出现对子或更多同点牌');
ok(bottomWithBomb > 0, '底牌可以出现炸弹');
console.log('    ' + N + ' 局校验耗时 ' + (Date.now() - started) + ' ms');
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
