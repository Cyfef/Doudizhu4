/*
 * cards.js — 两副牌构建与多阶段随机发牌（UMD）
 *
 * 发牌阶段：
 *  1. 随机生成普通炸弹总数及 4~8 张炸弹的类别数量；
 *  2. 为每个炸弹随机选择互不重复的普通点数；
 *  3. 随机生成四位玩家各自获得的炸弹数量；
 *  4. 按该数量随机分配炸弹，并保证任何玩家不超过 25 张；
 *  5. 以独立概率决定是否产生火箭；
 *  6. 火箭随机分给仍放得下 4 张牌的玩家；
 *  7. 重新洗匀全部余牌，从当前牌最少的玩家开始逆时针补牌，四家补到
 *     25 张后自然留下最后 8 张作为底牌。
 *
 * 最终补牌会重试，确保玩家起手中的炸弹数量和张数类别与第 1~4 阶段的
 * 计划一致；底牌本身完全自然随机，可以出现王、对子乃至炸弹。
 */
(function (global) {
  'use strict';

  var SUITS = ['♠', '♥', '♣', '♦'];
  var RED_SUITS = { '♥': true, '♦': true };
  var NORMAL_RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  var PLAYER_COUNT = 4;
  var HAND_SIZE = 25;
  var BOTTOM_SIZE = 8;

  // 普通炸弹总数服从 N(10, 1)，仅在极端尾部夹到 6~14；火箭独立 5%。
  // sizeWeights 可重复填写来直观调整各种张数炸弹的相对概率。
  var BOMB_TARGET = {
    mean: 10, sd: 1, min: 6, max: 14, rocketP: 0.05,
    // 4/5/6/7/8 张炸弹的权重分别为 80/14/3/2/1。
    sizeWeights: [
      4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,
      4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,
      4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,
      4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,
      5,5,5,5,5,5,5,5,5,5,5,5,5,5,
      6,6,6,
      7,7,
      8
    ]
  };

  function randInt(n) { return Math.floor(Math.random() * n); }

  function rankLabel(v) {
    if (v <= 10) return String(v);
    if (v === 11) return 'J';
    if (v === 12) return 'Q';
    if (v === 13) return 'K';
    if (v === 14) return 'A';
    if (v === 15) return '2';
    if (v === 16) return '小王';
    if (v === 17) return '大王';
    return String(v);
  }

  function makeCard(rank, suit, isJoker) {
    return {
      id: '', rank: rank, suit: suit, label: rankLabel(rank),
      color: isJoker ? (rank === 17 ? 'red' : 'black') : (RED_SUITS[suit] ? 'red' : 'black'),
      isJoker: !!isJoker
    };
  }

  function buildDeck() {
    var deck = [], idx = 0;
    for (var rank = 3; rank <= 15; rank++) {
      for (var suit = 0; suit < SUITS.length; suit++) {
        for (var copy = 0; copy < 2; copy++) {
          var card = makeCard(rank, SUITS[suit], false);
          card.id = 'c_' + rank + '_' + SUITS[suit] + '_' + copy;
          card.seq = idx++;
          deck.push(card);
        }
      }
    }
    for (var jc = 0; jc < 2; jc++) {
      var small = makeCard(16, 'J', true); small.id = 'j_16_' + jc; small.seq = idx++; deck.push(small);
      var big = makeCard(17, 'J', true); big.id = 'j_17_' + jc; big.seq = idx++; deck.push(big);
    }
    return deck;
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = randInt(i + 1), t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function sortHand(hand) {
    hand.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return (a.suit || '').localeCompare(b.suit || '');
    });
    return hand;
  }

  function gauss(mean, sd) {
    var u = Math.random(); if (u < 1e-12) u = 1e-12;
    var v = Math.random();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // 阶段 1、2：确定普通炸弹总数/类别，再随机选择互不重复的点数。
  function createBombPlan() {
    var total = Math.round(gauss(BOMB_TARGET.mean, BOMB_TARGET.sd));
    if (total < BOMB_TARGET.min) total = BOMB_TARGET.min;
    if (total > BOMB_TARGET.max) total = BOMB_TARGET.max;
    var sizeList = [];
    for (var i = 0; i < total; i++) {
      sizeList.push(BOMB_TARGET.sizeWeights[randInt(BOMB_TARGET.sizeWeights.length)]);
    }
    // 普通点数只有 13 个。极少数 T>13 的局，用同一点数拆成两副 4 张炸弹；
    // 两副稍后必须分给不同玩家，绝不会在同一手里合成 8 张。
    var pairedRanks = Math.max(0, total - NORMAL_RANKS.length);
    for (var forced = 0; forced < pairedRanks * 2; forced++) sizeList[forced] = 4;

    var ranks = shuffle(NORMAL_RANKS.slice());
    var plan = [], sizes = { 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 }, si = 0;
    for (var pair = 0; pair < pairedRanks; pair++) {
      var pairedRank = ranks[pair];
      plan.push({ rank: pairedRank, size: 4, owner: null, paired: true });
      plan.push({ rank: pairedRank, size: 4, owner: null, paired: true });
      sizes[4] += 2; si += 2;
    }
    for (var rankIndex = pairedRanks; rankIndex < NORMAL_RANKS.length && plan.length < total; rankIndex++) {
      var size = sizeList[si++];
      sizes[size]++;
      plan.push({ rank: ranks[rankIndex], size: size, owner: null });
    }
    return { total: total, bombs: plan, sizes: sizes };
  }

  // 阶段 3、4：先随机出每人的炸弹“个数”，再把已确定类别的炸弹随机装进去。
  function assignBombOwners(plan) {
    for (var attempt = 0; attempt < 300; attempt++) {
      var bombCounts = [0, 0, 0, 0];
      for (var i = 0; i < plan.bombs.length; i++) bombCounts[randInt(PLAYER_COUNT)]++;
      if (bombCounts.some(function (n) { return n * 4 > HAND_SIZE; })) continue;

      var ownerSlots = [];
      for (var seat = 0; seat < PLAYER_COUNT; seat++) {
        for (var q = 0; q < bombCounts[seat]; q++) ownerSlots.push(seat);
      }
      shuffle(ownerSlots);
      var bombs = shuffle(plan.bombs.map(function (b) { return { rank: b.rank, size: b.size, owner: null }; }));
      var loads = [0, 0, 0, 0];
      for (var b = 0; b < bombs.length; b++) {
        bombs[b].owner = ownerSlots[b];
        loads[ownerSlots[b]] += bombs[b].size;
      }
      var ownersByRank = {}, sameOwnerPair = false;
      for (var x = 0; x < bombs.length; x++) {
        if (!ownersByRank[bombs[x].rank]) ownersByRank[bombs[x].rank] = {};
        if (ownersByRank[bombs[x].rank][bombs[x].owner]) { sameOwnerPair = true; break; }
        ownersByRank[bombs[x].rank][bombs[x].owner] = true;
      }
      if (sameOwnerPair) continue;
      if (loads.every(function (n) { return n <= HAND_SIZE; })) {
        return { bombs: bombs, bombCounts: bombCounts, loads: loads };
      }
    }
    return null;
  }

  function cardsByRank(deck) {
    var byRank = {};
    deck.forEach(function (card) {
      if (!byRank[card.rank]) byRank[card.rank] = [];
      byRank[card.rank].push(card);
    });
    for (var rank in byRank) if (byRank.hasOwnProperty(rank)) shuffle(byRank[rank]);
    return byRank;
  }

  function handCounts(hand) {
    var out = {};
    hand.forEach(function (card) { out[card.rank] = (out[card.rank] || 0) + 1; });
    return out;
  }

  function rocketSeatOf(hands) {
    for (var seat = 0; seat < PLAYER_COUNT; seat++) {
      var c = handCounts(hands[seat]);
      if ((c[16] || 0) === 2 && (c[17] || 0) === 2) return seat;
    }
    return null;
  }

  // 补牌之后只校验规划炸弹仍然存在；余牌可以让它变长，也可以自然形成新的炸弹。
  function matchesPlan(hands, bottom, bombs, rocketOwner) {
    var expected = [{}, {}, {}, {}];
    bombs.forEach(function (b) { expected[b.owner][b.rank] = b.size; });
    for (var seat = 0; seat < PLAYER_COUNT; seat++) {
      var actual = handCounts(hands[seat]);
      for (var rank in expected[seat]) {
        if ((actual[rank] || 0) < expected[seat][rank]) return false;
      }
    }
    if (rocketOwner != null && rocketSeatOf(hands) !== rocketOwner) return false;
    // 未规划火箭时仍遵守 5% 的独立判定，不让余牌或底牌意外合成火箭。
    if (rocketOwner == null) {
      if (rocketSeatOf(hands) != null) return false;
      for (var landlord = 0; landlord < PLAYER_COUNT; landlord++) {
        var merged = handCounts(hands[landlord].concat(bottom));
        if ((merged[16] || 0) === 2 && (merged[17] || 0) === 2) return false;
      }
    }
    return true;
  }

  function minLoadStart(loads) {
    var min = Math.min.apply(Math, loads);
    var seats = [];
    for (var i = 0; i < PLAYER_COUNT; i++) if (loads[i] === min) seats.push(i);
    return seats[randInt(seats.length)];
  }

  // 阶段 7：余牌全洗，按逆时针轮发；已满 25 张的玩家自动跳过。
  function fillHands(allocated, remaining) {
    var hands = allocated.map(function (h) { return h.slice(); });
    var pool = shuffle(remaining.slice());
    var loads = hands.map(function (h) { return h.length; });
    var seat = minLoadStart(loads);
    var dealCount = pool.length - BOTTOM_SIZE;
    for (var i = 0; i < dealCount; i++) {
      var guard = 0;
      while (hands[seat].length >= HAND_SIZE && guard++ < PLAYER_COUNT) seat = (seat + 3) % PLAYER_COUNT;
      if (hands[seat].length >= HAND_SIZE) return null;
      hands[seat].push(pool[i]);
      seat = (seat + 3) % PLAYER_COUNT;
    }
    if (hands.some(function (h) { return h.length !== HAND_SIZE; })) return null;
    return { hands: hands, bottom: pool.slice(dealCount) };
  }

  function tryBuild(plan, useRocket) {
    var assigned = assignBombOwners(plan);
    if (!assigned) return null;
    var byRank = cardsByRank(buildDeck());
    var allocated = [[], [], [], []];

    assigned.bombs.forEach(function (bomb) {
      var cards = byRank[bomb.rank].splice(0, bomb.size);
      Array.prototype.push.apply(allocated[bomb.owner], cards);
    });

    // 阶段 5、6：火箭独立判定后，随机分给当前仍能容纳 4 张牌的玩家。
    var rocketOwner = null;
    if (useRocket) {
      var eligible = [];
      for (var seat = 0; seat < PLAYER_COUNT; seat++) if (allocated[seat].length <= HAND_SIZE - 4) eligible.push(seat);
      if (!eligible.length) return null;
      rocketOwner = eligible[randInt(eligible.length)];
      Array.prototype.push.apply(allocated[rocketOwner], byRank[16].splice(0));
      Array.prototype.push.apply(allocated[rocketOwner], byRank[17].splice(0));
    }

    var remaining = [];
    for (var rank in byRank) if (byRank.hasOwnProperty(rank)) Array.prototype.push.apply(remaining, byRank[rank]);
    for (var attempt = 0; attempt < 240; attempt++) {
      var filled = fillHands(allocated, remaining);
      if (!filled || !matchesPlan(filled.hands, filled.bottom, assigned.bombs, rocketOwner)) continue;
      filled.hands.forEach(sortHand);
      sortHand(filled.bottom);
      filled.assignment = assigned;
      filled.rocketOwner = rocketOwner;
      return filled;
    }
    return null;
  }

  function randomDeal() {
    var deck = shuffle(buildDeck());
    var hands = [deck.slice(0, 25), deck.slice(25, 50), deck.slice(50, 75), deck.slice(75, 100)];
    hands.forEach(sortHand);
    var bottom = deck.slice(100); sortHand(bottom);
    return { hands: hands, bottom: bottom };
  }

  function deal() {
    var useRocket = Math.random() < BOMB_TARGET.rocketP;
    var plan = createBombPlan();
    for (var attempt = 0; attempt < 600; attempt++) {
      var result = tryBuild(plan, useRocket);
      if (!result) continue;
      result.meta = {
        targetBombs: plan.total + (useRocket ? 1 : 0),
        plannedOrdinaryBombs: plan.total,
        bombSizes: plan.sizes,
        playerBombCounts: result.assignment.bombCounts,
        plannedBombs: result.assignment.bombs.map(function (b) {
          return { rank: b.rank, size: b.size, owner: b.owner };
        }),
        rocket: useRocket,
        rocketSeat: result.rocketOwner,
        dealDirection: 'counterclockwise'
      };
      delete result.assignment;
      delete result.rocketOwner;
      return result;
    }
    var fallback = randomDeal();
    fallback.meta = { targetBombs: null, rocket: false, fallback: true };
    return fallback;
  }

  function bombCardIds(hand) {
    var counts = handCounts(hand), ids = {};
    hand.forEach(function (card) { if (card.rank <= 15 && counts[card.rank] >= 4) ids[card.id] = true; });
    var jokers = hand.filter(function (card) { return card.rank >= 16; });
    if ((counts[16] || 0) === 2 && (counts[17] || 0) === 2) jokers.forEach(function (card) { ids[card.id] = true; });
    return ids;
  }

  var api = {
    buildDeck: buildDeck, shuffle: shuffle, sortHand: sortHand,
    deal: deal, randomDeal: randomDeal,
    rankLabel: rankLabel, bombCardIds: bombCardIds, SUITS: SUITS,
    BOMB_TARGET: BOMB_TARGET
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DDZCards = api;
})(typeof window !== 'undefined' ? window : globalThis);
