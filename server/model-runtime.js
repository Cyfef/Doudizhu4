/*
 * model-runtime.js — 已部署人机模型的「特征编码 + 候选打分」（服务端，零依赖）
 *
 * 这是游戏运行所需的稳定推理组件，不包含训练、评估或模型导出功能。
 *
 * 输入 82 维 = state(62) + action(20)
 *   state(62) = 手牌点数计数(15) + 上一手牌点数计数(15) + 全场已出牌点数计数(15)
 *             + 上一手关系(无/自己/队友/对手)(4) + 地主标识(1)
 *             + 我方剩余/33(1) + 地主剩余/33(1) + 四家剩余/33(4)
 *             + 最小对手剩余/33(1) + 最小队友剩余/33(1) + 上一手玩家剩余/33(1)
 *             + 连续过牌数/3(1) + 上一手是否炸弹(1) + 上一手是否火箭(1)
 *   action(20) = 候选牌点数计数(15) + 是否过牌(1) + 出牌张数/33(1)
 *              + 牌型价值/1000(1) + 是否炸弹/火箭(1) + 是否高控制牌(1)
 *   点数口径：3..17 共 15 档（15=2，16=小王，17=大王），下标 = rank-3。
 *
 * 本文件刻意不 require bot.js（避免循环依赖）：它只做「状态/动作 → 向量」的纯函数，
 * 由 bot.js 负责枚举合法动作并做最终决策。
 */
'use strict';

var Model = require('./model.js');

var RANK_MIN = 3, RANK_MAX = 17, NR = 15;
var STATE_DIM = 62, ACTION_DIM = 20, INPUT_DIM = STATE_DIM + ACTION_DIM; // 82
var REM_NORM = 33.0;   // 张数归一化基准（地主满手 33 张）
var RANK_TWO = 15;

/** 一组牌 → 15 档点数计数（下标 = rank-3）。 */
function rankCounts(cards) {
  var c = new Array(NR);
  for (var i = 0; i < NR; i++) c[i] = 0;
  if (!cards) return c;
  for (var j = 0; j < cards.length; j++) {
    var r = cards[j].rank;
    if (typeof r === 'number' && r >= RANK_MIN && r <= RANK_MAX) c[r - RANK_MIN]++;
  }
  return c;
}

/**
 * encodeState(ctx) -> Float64Array(50)
 * ctx = {
 *   hand,            // 我的手牌 [{rank,...}]
 *   lastPlay,        // { seat, cards, info } | null
 *   mySeat, landlordSeat, isLandlord,
 *   counts,          // [c0,c1,c2,c3] 各家剩余张数
 *   playedCounts     // 15 档：全场已出牌计数（记牌）—— 缺了它模型学不会记牌
 * }
 */
function encodeState(ctx) {
  ctx = ctx || {};
  var hand = ctx.hand || [];
  var counts = ctx.counts || [0, 0, 0, 0];
  var landlordSeat = ctx.landlordSeat;
  var seat = ctx.mySeat;
  var isLL = (typeof ctx.isLandlord === 'boolean')
    ? (ctx.isLandlord ? 1 : 0)
    : (seat === landlordSeat ? 1 : 0);

  var hand_c = rankCounts(hand);
  var last_c = rankCounts(ctx.lastPlay && ctx.lastPlay.cards);
  var played_c = ctx.playedCounts;
  if (!played_c || played_c.length !== NR) {
    played_c = [];
    for (var z = 0; z < NR; z++) played_c.push(0);
  }

  var my_rem = hand.length / REM_NORM;
  var ll_rem = (counts[landlordSeat] || 0) / REM_NORM;

  var opp_rem = 1.0, team_rem = 1.0, s, m;
  if (isLL) {
    m = -1;
    for (s = 0; s < 4; s++) {
      if (s === landlordSeat) continue;
      var v = (counts[s] || 0) / REM_NORM;
      if (m < 0 || v < m) m = v;
    }
    opp_rem = (m < 0) ? 1.0 : m;
    team_rem = 1.0;                       // 地主没有队友（与 Python 侧一致）
  } else {
    opp_rem = ll_rem;
    m = -1;
    for (s = 0; s < 4; s++) {
      if (s === seat || s === landlordSeat) continue;
      var v2 = (counts[s] || 0) / REM_NORM;
      if (m < 0 || v2 < m) m = v2;
    }
    team_rem = (m < 0) ? 1.0 : m;
  }

  var relNone = 1, relSelf = 0, relTeam = 0, relOpp = 0;
  var lastRem = 1.0, lastIsBomb = 0, lastIsRocket = 0;
  if (ctx.lastPlay) {
    relNone = 0;
    var lastSeat = ctx.lastPlay.seat;
    lastRem = (counts[lastSeat] || 0) / REM_NORM;
    if (lastSeat === seat) relSelf = 1;
    else if (isLL) relOpp = 1;
    else if (lastSeat === landlordSeat) relOpp = 1;
    else relTeam = 1;
    var info = ctx.lastPlay.info || {};
    lastIsBomb = info.type === 'bomb' ? 1 : 0;
    lastIsRocket = info.type === 'rocket' ? 1 : 0;
  }

  var passPressure = Math.min(3, Number(ctx.consecutivePasses || ctx.passCount || 0)) / 3.0;
  var out = new Float64Array(STATE_DIM);
  var k = 0, i;
  for (i = 0; i < NR; i++) out[k++] = hand_c[i];
  for (i = 0; i < NR; i++) out[k++] = last_c[i];
  for (i = 0; i < NR; i++) out[k++] = played_c[i];
  out[k++] = relNone;
  out[k++] = relSelf;
  out[k++] = relTeam;
  out[k++] = relOpp;
  out[k++] = isLL;
  out[k++] = my_rem;
  out[k++] = ll_rem;
  for (i = 0; i < 4; i++) out[k++] = (counts[i] || 0) / REM_NORM;
  out[k++] = opp_rem;
  out[k++] = team_rem;
  out[k++] = lastRem;
  out[k++] = passPressure;
  out[k++] = lastIsBomb;
  out[k++] = lastIsRocket;
  return out;
}

/**
 * encodeAction(move) -> Float64Array(16)
 * move = { cards:[...] } 或 { pass:true } 或 null（null 视作过牌）
 */
function encodeAction(move) {
  var isPass = 1, act, length = 0, value = 0, isBomb = 0, highControl = 0;
  if (move && !move.pass && move.cards && move.cards.length) {
    act = rankCounts(move.cards);
    isPass = 0;
    length = Math.min(move.cards.length, 33) / REM_NORM;
    var info = move.info || {};
    value = Math.min(Number(info.value || 0), 1000) / 1000.0;
    isBomb = (info.type === 'bomb' || info.type === 'rocket') ? 1 : 0;
    highControl = isBomb ? 1 : 0;
    for (var j = 0; j < move.cards.length; j++) {
      if (move.cards[j].rank >= RANK_TWO) { highControl = 1; break; }
    }
  } else {
    act = rankCounts(null);
  }
  var out = new Float64Array(ACTION_DIM);
  for (var i = 0; i < NR; i++) out[i] = act[i];
  out[NR] = isPass;
  out[NR + 1] = length;
  out[NR + 2] = value;
  out[NR + 3] = isBomb;
  out[NR + 4] = highControl;
  return out;
}

/** 拼成网络输入（66 维）。 */
function encodeInput(stateVec, actionVec) {
  var x = new Float64Array(INPUT_DIM);
  for (var i = 0; i < STATE_DIM; i++) x[i] = stateVec[i];
  for (var j = 0; j < ACTION_DIM; j++) x[STATE_DIM + j] = actionVec[j];
  return x;
}

/**
 * 给一批候选动作打分：返回 Float64Array(n) 每个候选的 V(s,a) ∈ [-1,1]。
 * 一次性组批前向，比逐个调用快得多。
 */
function scoreCandidates(stateVec, cands) {
  var n = cands.length;
  var X = new Float32Array(n * INPUT_DIM);
  for (var i = 0; i < n; i++) {
    var x = encodeInput(stateVec, encodeAction(cands[i]));
    var o = i * INPUT_DIM;
    for (var j = 0; j < INPUT_DIM; j++) X[o + j] = x[j];
  }
  return Model.forwardBatch(X, n);
}

/** argmax（并列取第一个，与 numpy.argmax 行为一致）。 */
function argmax(V) {
  var best = 0;
  for (var i = 1; i < V.length; i++) if (V[i] > V[best]) best = i;
  return best;
}

module.exports = {
  NR: NR,
  STATE_DIM: STATE_DIM,
  ACTION_DIM: ACTION_DIM,
  INPUT_DIM: INPUT_DIM,
  rankCounts: rankCounts,
  encodeState: encodeState,
  encodeAction: encodeAction,
  encodeInput: encodeInput,
  scoreCandidates: scoreCandidates,
  argmax: argmax
};
