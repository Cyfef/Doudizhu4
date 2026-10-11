/*
 * rules.js — 斗地主牌型识别与比较引擎（UMD：服务端 require / 浏览器全局）
 * 两副牌（108 张）：点数 3..2（值 3..15），小王值 16，大王值 17。
 * 牌型：单张 / 对子 / 三张 / 三带二 / 顺子 / 连对 / 飞机 / 飞机带对 / 炸弹 / 火箭。
 * 删除：三带一、飞机带单、四带二、四带两对。炸弹不能带牌。
 */
(function (global) {
  'use strict';

  var JOKER_SMALL = 16;
  var JOKER_BIG = 17;
  var RANK_MAX_SEQ = 14; // 顺子/连对/飞机主牌最大到 A(14)，不含 2(15) 和王

  // 炸弹/火箭倍率（按张数）
  function bombMult(n) {
    switch (n) {
      case 4: return 2;
      case 5: return 4;
      case 6: return 8;
      case 7: return 16;
      case 8: return 32;
      default: return 1;
    }
  }

  function isConsecutive(arr) {
    for (var i = 1; i < arr.length; i++) {
      if (arr[i] !== arr[i - 1] + 1) return false;
    }
    return true;
  }

  /*
   * 识别一组牌的牌型。cards: [{rank,...}]。
   * 返回 null（非法）或 { type, value, length, count, bombMult }。
   *  - value: 用于同型比较的关键点数（顺子/连对/飞机取最大三张点数）。
   *  - length: 序列长度（单/对/三/三带二/炸弹/火箭固定 1；顺子=张数；连对=对数；飞机=组数）。
   *  - count: 牌张数。
   */
  function analyze(cards) {
    if (!cards || cards.length === 0) return null;
    var n = cards.length;

    // 火箭：2 小王 + 2 大王
    if (n === 4) {
      var small = 0, big = 0;
      for (var k = 0; k < n; k++) {
        if (cards[k].rank === JOKER_SMALL) small++;
        else if (cards[k].rank === JOKER_BIG) big++;
      }
      if (small === 2 && big === 2) return { type: 'rocket', value: 1000, length: 1, count: 4, bombMult: 2 };
    }

    // 炸弹：4..8 张同点（王不能组炸弹）
    if (n >= 4) {
      var r0 = cards[0].rank;
      var same = true;
      for (var i = 1; i < n; i++) { if (cards[i].rank !== r0) { same = false; break; } }
      if (same && r0 <= 15) {
        return { type: 'bomb', value: r0, length: 1, count: n, bombMult: bombMult(n) };
      }
    }

    // 统计点数分布
    var counts = {};
    for (var c = 0; c < n; c++) {
      var r = cards[c].rank;
      counts[r] = (counts[r] || 0) + 1;
    }
    var entries = [];
    for (var key in counts) {
      if (counts.hasOwnProperty(key)) entries.push({ r: Number(key), c: counts[key] });
    }
    entries.sort(function (a, b) { return a.r - b.r; });
    var ranks = entries.map(function (e) { return e.r; });
    var uniq = ranks.length;
    var maxRank = ranks[ranks.length - 1];
    var hasJoker = entries.some(function (e) { return e.r >= 16; });

    if (n === 1) return { type: 'single', value: cards[0].rank, length: 1, count: 1 };
    if (n === 2) {
      if (uniq === 1 && maxRank <= JOKER_BIG) return { type: 'pair', value: maxRank, length: 1, count: 2 };
      return null;
    }
    if (n === 3) {
      if (uniq === 1 && maxRank <= 15) return { type: 'triple', value: maxRank, length: 1, count: 3 };
      return null;
    }
  if (n === 5) {
    if (hasJoker) return null;
    var triple = entries.filter(function (e) { return e.c === 3; })[0];
    var pair = entries.filter(function (e) { return e.c === 2; })[0];
    if (triple && pair && uniq === 2) return { type: 'triple_pair', value: triple.r, length: 1, count: 5 };
    // 否则可能是 5 张顺子，继续向下判断
  }
    // 顺子：>=5 张连续单牌
    if (n >= 5 && uniq === n && maxRank <= RANK_MAX_SEQ && isConsecutive(ranks)) {
      return { type: 'straight', value: maxRank, length: n, count: n };
    }
    // 连对：>=3 对连续对子
    if (n >= 6 && n % 2 === 0 && uniq >= 3 && maxRank <= RANK_MAX_SEQ &&
        entries.every(function (e) { return e.c === 2; }) && isConsecutive(ranks)) {
      return { type: 'straight_pair', value: maxRank, length: uniq, count: n };
    }
    // 飞机（纯三张，无翼）：>=2 组连续三张
    if (n >= 6 && n % 3 === 0 && uniq >= 2 && maxRank <= RANK_MAX_SEQ &&
        entries.every(function (e) { return e.c === 3; }) && isConsecutive(ranks)) {
      return { type: 'airplane', value: maxRank, length: uniq, count: n };
    }
    // 飞机带对：翼可以使用两个小王或两个大王；大小王混搭仍不是对子。
    if (n >= 10 && n % 5 === 0) {
      var k = n / 5;
      var triRanks = entries.filter(function (e) { return e.c === 3; }).map(function (e) { return e.r; });
      var pairRanks = entries.filter(function (e) { return e.c === 2; }).map(function (e) { return e.r; });
      var maxTriRank = triRanks.length ? Math.max.apply(null, triRanks) : 0;
      if (triRanks.length === k && pairRanks.length === k && maxTriRank <= RANK_MAX_SEQ) {
        var sortedTri = triRanks.slice().sort(function (a, b) { return a - b; });
        if (isConsecutive(sortedTri)) {
          var tset = {};
          triRanks.forEach(function (r) { tset[r] = true; });
          var overlap = pairRanks.some(function (r) { return tset[r]; });
          if (!overlap) return { type: 'airplane_pair', value: sortedTri[sortedTri.length - 1], length: k, count: n };
        }
      }
    }
    return null;
  }

  /*
   * a 是否能压过 b。b 为 null 表示自由出牌（首出/新一轮）。
   */
  function beats(a, b) {
    if (!a) return false;
    if (!b) return true;
    if (a.type === 'rocket') return true;
    if (b.type === 'rocket') return false;
    if (a.type === 'bomb') {
      if (b.type === 'bomb') {
        if (a.count !== b.count) return a.count > b.count;
        return a.value > b.value;
      }
      return true; // 炸弹压一切普通牌型
    }
    if (b.type === 'bomb') return false;
    if (a.type !== b.type) return false;
    if (a.length !== b.length) return false;
    return a.value > b.value;
  }

  // 当前整手牌里是否至少存在一种能压过 lastInfo 的合法出法。
  // 用于客户端在“确实要不起”时收起出牌/提示按钮；判断覆盖本作全部牌型。
  function canBeatWithHand(hand, lastInfo) {
    if (!lastInfo) return !!(hand && hand.length);
    if (!hand || !hand.length || lastInfo.type === 'rocket') return false;

    var counts = {};
    for (var i = 0; i < hand.length; i++) counts[hand[i].rank] = (counts[hand[i].rank] || 0) + 1;
    if ((counts[JOKER_SMALL] || 0) === 2 && (counts[JOKER_BIG] || 0) === 2) return true;

    var bombCanBeat = false;
    for (var r = 3; r <= 15; r++) {
      var bc = counts[r] || 0;
      if (bc < 4) continue;
      if (lastInfo.type !== 'bomb' || bc > lastInfo.count || (bc === lastInfo.count && r > lastInfo.value)) {
        bombCanBeat = true;
        break;
      }
    }
    if (lastInfo.type === 'bomb') return bombCanBeat;
    if (bombCanBeat) return true;

    var value = Number(lastInfo.value || 0);
    if (lastInfo.type === 'single') {
      for (var s = value + 1; s <= JOKER_BIG; s++) if ((counts[s] || 0) >= 1) return true;
      return false;
    }
    if (lastInfo.type === 'pair' || lastInfo.type === 'triple') {
      var need = lastInfo.type === 'pair' ? 2 : 3;
      for (var p = value + 1; p <= (need === 2 ? JOKER_BIG : 15); p++) if ((counts[p] || 0) >= need) return true;
      return false;
    }
    if (lastInfo.type === 'triple_pair') {
      for (var t = value + 1; t <= 15; t++) {
        if ((counts[t] || 0) < 3) continue;
        for (var pair = 3; pair <= 15; pair++) {
          if (pair !== t && (counts[pair] || 0) >= 2) return true;
        }
      }
      return false;
    }

    var groups = Number(lastInfo.length || 0);
    var perRank = lastInfo.type === 'straight' ? 1
      : (lastInfo.type === 'straight_pair' ? 2 : (lastInfo.type === 'airplane' || lastInfo.type === 'airplane_pair' ? 3 : 0));
    if (!groups || !perRank) return false;
    for (var end = value + 1; end <= RANK_MAX_SEQ; end++) {
      var start = end - groups + 1;
      if (start < 3) continue;
      var complete = true;
      for (var q = start; q <= end; q++) if ((counts[q] || 0) < perRank) { complete = false; break; }
      if (!complete) continue;
      if (lastInfo.type !== 'airplane_pair') return true;
      var availablePairs = 0;
      for (var pr = 3; pr <= JOKER_BIG; pr++) {
        if ((pr < start || pr > end) && (counts[pr] || 0) >= 2) availablePairs++;
      }
      if (availablePairs >= groups) return true;
    }
    return false;
  }

  // 牌型中文名（用于提示/日志）
  function typeName(t) {
    var map = {
      single: '单张', pair: '对子', triple: '三张', triple_pair: '三带二',
      straight: '顺子', straight_pair: '连对', airplane: '飞机',
      airplane_pair: '飞机带对', bomb: '炸弹', rocket: '火箭'
    };
    return map[t] || t;
  }

  var api = { analyze: analyze, beats: beats, canBeatWithHand: canBeatWithHand, bombMult: bombMult, typeName: typeName, JOKER_SMALL: JOKER_SMALL, JOKER_BIG: JOKER_BIG };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DDZRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
