/*
 * bot.js — 人机（机器人）决策引擎（服务端，零依赖）
 *
 * 定位：房间里直接可用的人机对手。接口采用「输入可见信息 → 输出决策」
 * 的纯函数形式，模型不可用时会自动使用启发式决策。
 *
 * 规则约束（与 public/js/rules.js 完全一致）：
 *   牌型：单张 / 对子 / 三张 / 三带二 / 顺子(>=5) / 连对(>=3对) / 飞机(>=2组)
 *        / 飞机带对 / 炸弹(4..8张同点) / 火箭(4张王)
 *   没有：三带一、飞机带单、四带二、四带两对；炸弹不能带牌。
 *   顺子/连对/飞机的主牌最大到 A(14)，不含 2(15) 与王。
 *   ⚠️ 单张王是合法牌型（single）——枚举时只有对子/三张/炸弹才限制 rank<=15。
 */
'use strict';

var path = require('path');
var DDZRules = require(path.join(__dirname, '..', 'public', 'js', 'rules.js'));

// ---------------- 神经网络策略（Coop-Bomb-v1） ----------------
/*
 * 已部署的人机价值网络权重位于 server/model.json，运行时不依赖训练工具。
 * 这里刻意做成「懒加载 + 失败降级」：模型文件缺失/损坏/维度不对时，人机自动退回启发式，
 * 绝不会因为一个可选增强让房间起不来。
 * 开关：环境变量 DDZ_BOT_NET=0 关闭（默认开启）；运行时也可 setUseNet(false)。
 */
var _rl = null;                                  // null=还没试过，false=加载失败，对象=可用
var _useNet = process.env.DDZ_BOT_NET !== '0';

function rlModule() {
  if (_rl !== null) return _rl;
  try {
    _rl = require('./model-runtime.js');
  } catch (e) {
    console.error('[bot] 人机模型运行时不可用，回退启发式：', e && e.message);
    _rl = false;
  }
  return _rl;
}
function setUseNet(v) { _useNet = !!v; }
function usingNet() {
  if (!_useNet) return false;
  var rl = rlModule();
  var model = require('./model.js');
  return !!rl && model.ready() && model.inputDim() === rl.INPUT_DIM;
}

var RANK_MIN = 3, RANK_MAX = 17, SEQ_MAX = 14, RANK_TWO = 15;
var MOVE_CAP = 800;          // 单个决策点最多枚举多少种出法（防组合爆炸）
var PAIR_COMB_RANKS = 8;     // 飞机带对：只从最小的 8 个对子点数里组合

// ---------------- 基础工具 ----------------

// 手牌 → 按点数计数（下标 = 点数 3..17，直接用量数当索引，方便查表）
function countsOf(hand) {
  var c = new Array(18);
  for (var i = 0; i < 18; i++) c[i] = 0;
  for (var j = 0; j < hand.length; j++) c[hand[j].rank]++;
  return c;
}
function sizeOf(counts) {
  var s = 0;
  for (var r = RANK_MIN; r <= RANK_MAX; r++) s += counts[r];
  return s;
}

// 把「点数 → 取几张」的方案映射回真实牌对象；取不到就返回 null
function materialize(hand, plan) {
  var need = {};
  for (var i = 0; i < plan.length; i++) {
    var r = plan[i][0], n = plan[i][1];
    need[r] = (need[r] || 0) + n;
  }
  var out = [], used = {};
  for (var key in need) {
    if (!need.hasOwnProperty(key)) continue;
    var rank = Number(key), want = need[key], got = 0;
    for (var k = 0; k < hand.length && got < want; k++) {
      if (used[hand[k].id]) continue;
      if (hand[k].rank !== rank) continue;
      used[hand[k].id] = 1; out.push(hand[k]); got++;
    }
    if (got < want) return null;
  }
  return out.length ? out : null;
}

// ---------------- 合法出牌枚举 ----------------
/*
 * genMoves(hand, lastInfo) -> [{ cards, info, plan }]
 * lastInfo 为 null 表示自由出牌（首出/新一轮），此时返回全部合法牌型；
 * 否则只返回「能压过 lastInfo」的那些（含炸弹/火箭）。
 */
function genMoves(hand, lastInfo) {
  var counts = countsOf(hand);
  var moves = [];
  function add(plan) {
    if (moves.length >= MOVE_CAP) return;
    var cards = materialize(hand, plan);
    if (!cards) return;
    var info = DDZRules.analyze(cards);   // 用权威规则再校验一次，杜绝枚举器与规则不一致
    if (!info) return;
    if (lastInfo && !DDZRules.beats(info, lastInfo)) return;
    moves.push({ cards: cards, info: info, plan: plan });
  }

  var ranks = [];
  for (var r = RANK_MIN; r <= RANK_MAX; r++) if (counts[r] > 0) ranks.push(r);

  // 单张（含单张王）/ 对子 / 三张 / 炸弹
  for (var a = 0; a < ranks.length; a++) {
    var rank = ranks[a], n = counts[rank];
    add([[rank, 1]]);
    // 两张同色王可作为对子；三张及炸弹仍只允许普通点数。
    if (n >= 2) add([[rank, 2]]);
    if (rank <= RANK_TWO) {
      if (n >= 3) add([[rank, 3]]);
      for (var bn = 4; bn <= n; bn++) add([[rank, bn]]);   // 4~8 张同点都是炸弹
    }
  }
  // 火箭：2 小王 + 2 大王
  if (counts[16] >= 2 && counts[17] >= 2) add([[16, 2], [17, 2]]);

  // 三带二
  for (var t = 0; t < ranks.length; t++) {
    var tr = ranks[t];
    if (tr > RANK_TWO || counts[tr] < 3) continue;
    for (var pi = 0; pi < ranks.length; pi++) {
      var pr = ranks[pi];
      if (pr === tr || pr > RANK_TWO || counts[pr] < 2) continue;
      add([[tr, 3], [pr, 2]]);
    }
  }
  // 顺子（>=5 张连续单牌）
  for (var slen = 5; slen <= 12; slen++) {
    for (var s1 = RANK_MIN; s1 + slen - 1 <= SEQ_MAX; s1++) {
      var ok = true, plan1 = [];
      for (var i1 = 0; i1 < slen; i1++) {
        if (counts[s1 + i1] < 1) { ok = false; break; }
        plan1.push([s1 + i1, 1]);
      }
      if (ok) add(plan1);
    }
  }
  // 连对（>=3 对连续对子）
  for (var plen = 3; plen <= 10; plen++) {
    for (var s2 = RANK_MIN; s2 + plen - 1 <= SEQ_MAX; s2++) {
      var ok2 = true, plan2 = [];
      for (var i2 = 0; i2 < plen; i2++) {
        if (counts[s2 + i2] < 2) { ok2 = false; break; }
        plan2.push([s2 + i2, 2]);
      }
      if (ok2) add(plan2);
    }
  }
  // 飞机（>=2 组连续三张，不带翼）
  for (var ak = 2; ak <= 6; ak++) {
    for (var s3 = RANK_MIN; s3 + ak - 1 <= SEQ_MAX; s3++) {
      var ok3 = true, plan3 = [];
      for (var i3 = 0; i3 < ak; i3++) {
        if (counts[s3 + i3] < 3) { ok3 = false; break; }
        plan3.push([s3 + i3, 3]);
      }
      if (ok3) add(plan3);
    }
  }
  // 飞机带对：k 组连续三张 + k 个对子；同色双王也可作为翼对子。
  for (var k = 2; k <= 6; k++) {
    for (var s4 = RANK_MIN; s4 + k - 1 <= SEQ_MAX; s4++) {
      var tri = {}, ok4 = true, plan4 = [];
      for (var i4 = 0; i4 < k; i4++) {
        if (counts[s4 + i4] < 3) { ok4 = false; break; }
        tri[s4 + i4] = 1;
        plan4.push([s4 + i4, 3]);
      }
      if (!ok4) continue;
      var pairRanks = [];
      for (var pr2 = RANK_MIN; pr2 <= RANK_MAX; pr2++) {
        if (tri[pr2] || counts[pr2] < 2) continue;
        pairRanks.push(pr2);
      }
      // 只从最小的若干个对子点数里做组合，避免组合爆炸（真实牌局里也几乎只会用最小的翼）
      var pool = pairRanks.slice(0, PAIR_COMB_RANKS);
      if (pool.length < k) continue;
      var combos = combinations(pool, k);
      for (var c = 0; c < combos.length; c++) {
        var plan = plan4.slice();
        for (var w = 0; w < combos[c].length; w++) plan.push([combos[c][w], 2]);
        add(plan);
      }
    }
  }
  return moves;
}

function combinations(arr, k) {
  var out = [];
  (function walk(start, cur) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (var i = start; i < arr.length; i++) { cur.push(arr[i]); walk(i + 1, cur); cur.pop(); }
  })(0, []);
  return out;
}

// ---------------- 手牌牌力评估 ----------------
/*
 * powerOf(hand)：把一手牌压成一个「牌力分」，越大越强。
 *
 * 权重是经验值，而下面的阈值表是用**本作偏置发牌的实际分布**标定的
 * （目标炸弹 N(10,1)，4/5/6/7/8 张权重 80/14/3/2/1 的实测分位）：
 *     25 张（农民）  p25≈24  p50≈29  p75≈35  p90≈41  p95≈45
 *     33 张（地主）  p25≈34  p50≈39  p75≈45  p90≈52  p95≈56
 * 阈值按同等张数手牌的分位设置，并保留少量随机扰动，避免每局行为完全一致。
 * ⚠️ 一旦调整 cards.js 的发牌策略，这张阈值表就必须重新标定 —— 否则人机
 *    的叫分/加倍会整体偏松或偏紧。
 */
function powerOf(hand) {
  var counts = countsOf(hand);
  var score = 0;
  score += 6.0 * counts[17];                        // 大王
  score += 4.5 * counts[16];                        // 小王
  score += 3.0 * counts[RANK_TWO];                  // 2
  score += 1.2 * counts[14];                        // A
  score += 0.5 * counts[13];                        // K
  for (var r = RANK_MIN; r <= RANK_TWO; r++) {      // 炸弹（4..8 张同点）
    if (counts[r] >= 4) score += 4.0 + (counts[r] - 4) * 2.0;
  }
  if (counts[16] >= 2 && counts[17] >= 2) score += 7.0;   // 火箭
  return score;
}

// 阈值表（按手牌规模分档：>=30 张即拿了底牌的地主）
var TH = {
  bid: { three: 43, two: 36, one: 30 },        // 叫分时人人都是 25 张
  big: { reveal: 48, mult4: 54, mult2: 47 },   // 地主 33 张
  small: { mult4: 44, mult2: 36 }              // 农民 25 张
};
function isBigHand(hand) { return hand.length >= 30; }
// 仅供参考/展示：原始分不做归一化（归一化会掩盖「地主天然更强」这个事实）

// ---------------- 四个决策点 ----------------

// 叫分：返回 0(不叫) / 1 / 2 / 3，保证要么 0 要么 > highest
function chooseBid(hand, highest) {
  var s = powerOf(hand) + (Math.random() - 0.5) * 2.4;   // 一点噪声，避免每局都一个样
  var want = 0;
  if (s >= TH.bid.three) want = 3;
  else if (s >= TH.bid.two) want = 2;
  else if (s >= TH.bid.one) want = 1;
  highest = Number(highest) || 0;
  if (want <= highest) return 0;
  return want;
}

// 明牌（仅地主，×2）：牌力很强才明牌，否则风险大于收益
function chooseReveal(hand) {
  if (!isBigHand(hand)) return false;
  return powerOf(hand) >= TH.big.reveal;
}

// 加倍：1 不加倍 / 2 加倍 / 4 超级加倍
function chooseMultiply(hand) {
  var s = powerOf(hand) + (Math.random() - 0.5) * 2.0;
  var th = isBigHand(hand) ? TH.big : TH.small;
  if (s >= th.mult4) return 4;
  if (s >= th.mult2) return 2;
  return 1;
}

/*
 * choosePlay(ctx) -> { cards } 或 { pass: true }
 * 优先使用已部署模型；模型不可用（权重缺失/损坏/开关关闭）时退回启发式。
 *
 * ctx = {
 *   hand, lastPlay, mySeat, landlordSeat, isLandlord,
 *   counts,          // [c0,c1,c2,c3] 各家剩余张数
 *   playedCounts     // 15 档全场已出牌计数（记牌）—— 网络策略需要
 * }
 */
function choosePlay(ctx) {
  var dec = choosePlayNet(ctx);
  if (dec) return dec;
  return choosePlayHeuristic(ctx);
}

/*
 * choosePlayNet(ctx) -> 决策 或 null（null = 用不了网络，交给启发式）
 *
 * 决策流程：枚举全部合法出法（+ 跟牌时的过牌）-> 逐条组批前向
 * -> 取 V(s,a) 最大的那个。因为动作集就是「合法动作集」，网络不可能选到非法牌。
 * 唯一的人为捷径：如果某手能一把走完，直接走（这是严格占优，不必问网络）。
 */
function choosePlayNet(ctx) {
  if (!usingNet()) return null;
  var rl = rlModule();
  var hand = ctx.hand || [];
  if (!hand.length) return { pass: true };
  var lastInfo = (ctx.lastPlay && ctx.lastPlay.info) ? ctx.lastPlay.info : null;
  var moves = genMoves(hand, lastInfo);

  // 能一把走完就走完（含跟牌反杀）：严格占优，比问网络更可靠
  for (var f = 0; f < moves.length; f++) {
    if (moves[f].cards.length === hand.length) return { cards: moves[f].cards };
  }

  var cands = moves.slice();
  if (lastInfo) cands.push({ pass: true });     // 只有跟牌时才能选择不要
  cands = filterCoopCandidates(ctx, cands);
  cands = filterStrategicCandidates(ctx, cands);
  if (!cands.length) return { pass: true };

  var V = rl.scoreCandidates(rl.encodeState(ctx), cands);
  if (!V) return null;
  var best = cands[rl.argmax(V)];
  return best.pass ? { pass: true } : { cards: best.cards };
}

// 启发式策略（模型不可用时的兜底，并负责关键局面的保护逻辑）
function choosePlayHeuristic(ctx) {
  var hand = ctx.hand || [];
  if (!hand.length) return { pass: true };
  var lastInfo = (ctx.lastPlay && ctx.lastPlay.info) ? ctx.lastPlay.info : null;
  var moves = genMoves(hand, lastInfo);
  if (!moves.length) return { pass: true };

  // 1) 能一把走完就走完（最高优先级，包括跟牌时反杀）
  for (var f = 0; f < moves.length; f++) {
    if (moves[f].cards.length === hand.length) return { cards: moves[f].cards };
  }

  var isLandlord = !!ctx.isLandlord;
  var seat = ctx.mySeat || 0;
  var counts = ctx.counts || [0, 0, 0, 0];
  var mySize = hand.length;

  // 找「对家」的信息
  var lastSeat = ctx.lastPlay ? ctx.lastPlay.seat : null;
  // 我是农民、上家也是农民（且不是地主）→ 是队友
  var lastIsTeammate = (lastSeat != null) && !isLandlord &&
    lastSeat !== seat && lastSeat !== ctx.landlordSeat;
  // 对手（从我的视角）：地主看我、农民看地主；王/农民同伙不算对手
  function isOpponent(s) {
    if (s == null || s === seat) return false;
    if (isLandlord) return s !== ctx.landlordSeat;
    return s === ctx.landlordSeat;
  }
  var opponentsLeft = [];
  for (var i = 0; i < 4; i++) if (isOpponent(i)) opponentsLeft.push(counts[i] || 0);
  var minOpp = opponentsLeft.length ? Math.min.apply(null, opponentsLeft) : 99;
  var minTeammate = 99;
  if (!isLandlord) {
    for (var t = 0; t < 4; t++) {
      if (t === seat || t === ctx.landlordSeat) continue;
      minTeammate = Math.min(minTeammate, counts[t] || 0);
    }
  }

  var filtered = filterStrategicCandidates(ctx, moves.concat(lastInfo ? [{ pass: true }] : []))
    .filter(function (m) { return !m.pass; });
  if (filtered.length) moves = filtered;
  var normals = moves.filter(function (m) { return m.info.type !== 'bomb' && m.info.type !== 'rocket'; });
  var bombs = moves.filter(function (m) { return m.info.type === 'bomb' || m.info.type === 'rocket'; });

  // ---------------- 跟牌 ----------------
  if (lastInfo) {
    // 同伙出的牌：通常不压（把出牌权留给队友）
    if (lastIsTeammate) {
      var coop = filterCoopCandidates(ctx, moves.concat([{ pass: true }]))
        .filter(function (m) { return !m.pass; });
      if (coop.length) return { cards: smallest(coop).cards };
      return { pass: true };
    }
    if (normals.length) {
      var pick = smallest(normals);
      // 省牌：只剩大牌可压（2 或王）、自己牌还多、对手也还多时，不值得为一个小牌面花掉它
      var tooCostly = pick.info.value >= RANK_TWO && mySize >= 8 && minOpp >= 5;
      if (!tooCostly) return { cards: pick.cards };
      // 对手快走完了就必须压，不能再省
      if (minOpp <= 4) return { cards: pick.cards };
      return { pass: true };
    }
    // 只能用炸弹：对手快走完 / 我这手炸完能接近收尾 / 队友已无望时才炸
    if (bombs.length) {
      var urgent = minOpp <= 2 || mySize <= 6;
      if (urgent) return { cards: smallest(bombs).cards };
      // 小概率用炸弹压制，避免人机永远死守炸弹、显得呆板
      if (Math.random() < 0.12) return { cards: smallest(bombs).cards };
    }
    return { pass: true };
  }

  // ---------------- 自由出牌（领出）----------------
  return { cards: chooseLead(hand, moves, normals, bombs, {
    isLandlord: isLandlord, minOpp: minOpp, minTeammate: minTeammate
  }).cards };
}

function smallest(list) {
  var best = list[0];
  for (var i = 1; i < list.length; i++) {
    var a = list[i];
    if (a.cards.length !== best.cards.length) { if (a.cards.length < best.cards.length) best = a; continue; }
    if (a.info.value < best.info.value) best = a;
  }
  return best;
}

function isLastPlayByTeammate(ctx) {
  if (!ctx || !ctx.lastPlay || ctx.isLandlord) return false;
  var seat = ctx.mySeat || 0;
  var lastSeat = ctx.lastPlay.seat;
  return lastSeat != null && lastSeat !== seat && lastSeat !== ctx.landlordSeat;
}

function isBombMove(move) {
  return !!(move && move.info && (move.info.type === 'bomb' || move.info.type === 'rocket'));
}

function hasHighControl(move) {
  if (!move || move.pass) return false;
  if (isBombMove(move)) return true;
  for (var i = 0; i < (move.cards || []).length; i++) {
    if (move.cards[i].rank >= RANK_TWO) return true;
  }
  return false;
}

function filterCoopCandidates(ctx, cands) {
  if (!ctx || !ctx.lastPlay || ctx.isLandlord || !isLastPlayByTeammate(ctx)) return cands;
  var hand = ctx.hand || [];
  var counts = ctx.counts || [0, 0, 0, 0];
  var landlordLeft = counts[ctx.landlordSeat] || 0;
  var passMove = null;
  for (var i = 0; i < cands.length; i++) if (cands[i].pass) passMove = cands[i];

  var finishers = cands.filter(function (m) {
    return !m.pass && m.cards && m.cards.length === hand.length;
  });
  if (finishers.length) return finishers;

  var lastType = (ctx.lastPlay.info || {}).type;
  if (lastType === 'bomb' || lastType === 'rocket') {
    if (landlordLeft <= 1) {
      var nonBomb = cands.filter(function (m) { return !m.pass && !isBombMove(m); });
      if (nonBomb.length) return passMove ? nonBomb.concat([passMove]) : nonBomb;
    }
    return passMove ? [passMove] : [];
  }

  var cheap = cands.filter(function (m) { return !m.pass && !hasHighControl(m); });
  if (cheap.length) return passMove ? cheap.concat([passMove]) : cheap;
  return passMove ? [passMove] : cands;
}

function handCounts(hand) {
  var out = {};
  for (var i = 0; i < (hand || []).length; i++) {
    var r = hand[i].rank;
    out[r] = (out[r] || 0) + 1;
  }
  return out;
}

function breaksBomb(move, counts) {
  if (!move || move.pass || isBombMove(move)) return false;
  var used = {};
  for (var i = 0; i < (move.cards || []).length; i++) {
    var r = move.cards[i].rank;
    used[r] = (used[r] || 0) + 1;
  }
  for (var k in used) {
    if (!used.hasOwnProperty(k)) continue;
    var rank = Number(k);
    if (rank <= RANK_TWO && (counts[rank] || 0) >= 4 && used[k] < counts[rank]) return true;
  }
  return false;
}

function strategicInfo(ctx) {
  ctx = ctx || {};
  var seat = ctx.mySeat || 0;
  var isLandlord = !!ctx.isLandlord;
  var counts = ctx.counts || [0, 0, 0, 0];
  function isOpponent(s) {
    if (s == null || s === seat) return false;
    if (isLandlord) return s !== ctx.landlordSeat;
    return s === ctx.landlordSeat;
  }
  var minOpp = 99;
  for (var i = 0; i < 4; i++) if (isOpponent(i)) minOpp = Math.min(minOpp, counts[i] || 0);
  return { minOpp: minOpp };
}

function filterStrategicCandidates(ctx, cands) {
  var hand = (ctx && ctx.hand) || [];
  if (!hand.length || !cands || !cands.length) return cands || [];
  var lastInfo = (ctx.lastPlay && ctx.lastPlay.info) ? ctx.lastPlay.info : null;
  var hCounts = handCounts(hand);
  var info = strategicInfo(ctx);
  var passMove = null;
  var finishers = [];
  var ordinarySafe = [];
  var ordinaryBreak = [];
  var bombs = [];

  for (var i = 0; i < cands.length; i++) {
    var m = cands[i];
    if (m.pass) { passMove = m; continue; }
    if (m.cards && m.cards.length === hand.length) { finishers.push(m); continue; }
    if (isBombMove(m)) bombs.push(m);
    else if (breaksBomb(m, hCounts)) ordinaryBreak.push(m);
    else ordinarySafe.push(m);
  }
  if (finishers.length) return finishers;

  var urgent = info.minOpp <= 2 || hand.length <= 6;
  var strongNeed = info.minOpp <= 1 || hand.length <= 4;

  if (lastInfo) {
    if (lastInfo.type !== 'bomb' && lastInfo.type !== 'rocket') {
      if (ordinarySafe.length) return passMove ? ordinarySafe.concat([passMove]) : ordinarySafe;
      if (ordinaryBreak.length && (urgent || !bombs.length)) return passMove ? ordinaryBreak.concat([passMove]) : ordinaryBreak;
      if (bombs.length && strongNeed) return passMove ? bombs.concat([passMove]) : bombs;
      return passMove ? [passMove] : [];
    }
    // 对方已经出炸，拆普通炸弹资源去凑普通牌没有意义；保留合法更大炸弹/火箭。
    return passMove ? bombs.concat([passMove]) : bombs;
  }

  // 自由领出时，优先保持炸弹完整；拆炸只在接近收尾或没有不拆炸的普通打法时放开。
  if (ordinarySafe.length) {
    var breakFinishLike = ordinaryBreak.filter(function (m) { return hand.length - m.cards.length <= 2; });
    return ordinarySafe.concat(breakFinishLike);
  }
  if (ordinaryBreak.length && (urgent || !bombs.length)) return ordinaryBreak;
  return cands;
}

/*
 * 领出策略（启发式）：
 *   - 农民队友只剩 1 张 → 出最小单张把出牌权递给他（喂牌）
 *   - 对手只剩 1 张 → 优先出「多张组合」（单张他能轻松接走）
 *   - 否则优先甩长组合（顺子/连对/飞机）减少手数，再依次三带二、三张、对子、单张
 *   - 全程不主动送炸弹（除非手里只剩炸弹）
 */
function chooseLead(hand, moves, normals, bombs, info) {
  var cands = normals.length ? normals : bombs;
  var byLen = function (a, b) { return (b.cards.length - a.cards.length) || (a.info.value - b.info.value); };
  var byVal = function (a, b) { return a.info.value - b.info.value; };

  // 队友只剩 1 张（农民）→ 递最小单张
  if (!info.isLandlord && info.minTeammate === 1) {
    var singles = cands.filter(function (m) { return m.info.type === 'single'; });
    if (singles.length) return smallest(singles);
  }
  // 对手只剩 1 张 → 出对子/三张/长组合，别给他单张机会
  if (info.minOpp === 1) {
    var multi = cands.filter(function (m) { return m.cards.length >= 2; });
    if (multi.length) {
      var longFirst = multi.filter(function (m) {
        return m.info.type === 'straight' || m.info.type === 'straight_pair' ||
          m.info.type === 'airplane' || m.info.type === 'airplane_pair';
      });
      if (longFirst.length) return longFirst.sort(byLen)[0];
      return smallest(multi);
    }
  }

  // 长组合（顺子/连对/飞机/飞机带对）优先：一次走最多张
  var longs = cands.filter(function (m) {
    return m.info.type === 'straight' || m.info.type === 'straight_pair' ||
      m.info.type === 'airplane' || m.info.type === 'airplane_pair';
  });
  if (longs.length) {
    // 找最长的；同样长取最小的
    var best = longs[0];
    for (var i = 1; i < longs.length; i++) {
      if (longs[i].cards.length > best.cards.length ||
        (longs[i].cards.length === best.cards.length && longs[i].info.value < best.info.value)) best = longs[i];
    }
    // 别把顺子拆了留一堆散牌：只有当这手不少于 5 张时才优先
    if (best.cards.length >= 5) return best;
  }
  // 三带二 / 三张
  var tri = cands.filter(function (m) { return m.info.type === 'triple_pair' || m.info.type === 'triple'; });
  if (tri.length) return smallest(tri);
  // 对子：优先出普通小对子，必要时也允许对 2、对小王或对大王
  var pairs = cands.filter(function (m) { return m.info.type === 'pair'; });
  var cheapPairs = pairs.filter(function (m) { return m.info.value < RANK_TWO; });
  if (cheapPairs.length) return smallest(cheapPairs);
  if (pairs.length) return smallest(pairs);
  // 单张：先出小的，尽量留住 2 和王
  var singlesAll = cands.filter(function (m) { return m.info.type === 'single'; });
  var cheapSingles = singlesAll.filter(function (m) { return m.info.value < RANK_TWO; });
  if (cheapSingles.length) return smallest(cheapSingles);
  if (singlesAll.length) return smallest(singlesAll);
  return cands.slice().sort(byVal)[0];
}

// 思考延时：模拟人「想一下」，避免人机瞬间出牌显得机械
function thinkDelay(phase) {
  if (phase === 'bidding') return 600 + Math.floor(Math.random() * 700);
  if (phase === 'multiply') return 500 + Math.floor(Math.random() * 900);
  return 800 + Math.floor(Math.random() * 1100);
}

module.exports = {
  genMoves: genMoves,
  countsOf: countsOf,
  sizeOf: sizeOf,
  powerOf: powerOf,
  thresholds: TH,
  chooseBid: chooseBid,
  chooseReveal: chooseReveal,
  chooseMultiply: chooseMultiply,
  choosePlay: choosePlay,
  choosePlayNet: choosePlayNet,
  choosePlayHeuristic: choosePlayHeuristic,
  filterStrategicCandidates: filterStrategicCandidates,
  setUseNet: setUseNet,
  usingNet: usingNet,
  thinkDelay: thinkDelay
};
