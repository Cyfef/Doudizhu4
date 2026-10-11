/*
 * room.js — 房间状态机与服务端权威逻辑
 * 阶段：waiting -> bidding -> reveal -> multiply -> playing -> settle -> (下一局 | roomEnd)
 * 全程服务端权威：发牌/叫分/明牌/加倍/出牌校验/结算/排行榜均由本类完成。
 */
'use strict';

var path = require('path');
var fs = require('fs');
var DDZRules = require(path.join(__dirname, '..', 'public', 'js', 'rules.js'));
var DDZCards = require(path.join(__dirname, '..', 'public', 'js', 'cards.js'));
var Bot = require(path.join(__dirname, 'bot.js'));

var DATA_DIR = process.env.ROOM_DATA_DIR || path.join(__dirname, 'data');

function emptyStats() {
  return {
    win: 0, lose: 0, total: 0, landlordWin: 0, farmerWin: 0,
    bombCount: 0, rocketCount: 0, springCount: 0,
    maxMult: 0, maxScore: '0'
  };
}

function defaultConfig() {
  return {
    baseScore: 1,
    totalRounds: 5,
    bidTimeout: 10,
    choiceTimeout: 10,
    playTimeout: 15,
    dealMode: 'enhanced',
    password: '',
    allowReveal: true,
    allowDouble: true,
    allowNegative: true
  };
}

var ROOM_SEQ = 1;

function genRoomNo() {
  // 6 位数字房间号
  return String(100000 + Math.floor(Math.random() * 900000));
}

function Room(opts) {
  opts = opts || {};
  this.roomNo = opts.roomNo || genRoomNo();
  this.name = opts.name || ('房间' + this.roomNo);
  this.config = Object.assign(defaultConfig(), opts.config || {});
  this.players = [];                 // 长度<=4，按座位 0..3，离开后为 null
  this.hostSeat = 0;
  this.phase = 'waiting';
  this.round = 0;
  this.totalRounds = this.config.totalRounds;
  this.clients = {};                 // nick -> Set(res)
  this.timer = null;
  this._cannotBeatTimer = null;
  this.deadline = null;
  this.paused = false;
  this.pausedBy = null;
  this.lastWinnerSeat = null;
  // 单局公开状态（供 getState 在任意阶段安全读取）
  this.bids = [];
  this.multiplyChoices = {};
  this.revealChoice = false;
  this.bombMult = 1;
  // 局内互动（表情 / 道具 / 快捷语）：按 id 递增广播，客户端只处理新消息
  this.interactions = [];
  this._interactSeq = 0;
  this._lastInteractAt = {};
  // 过牌事件（谁过了牌）：同样按 id 递增，客户端只播报新增的，用于“不要”语音
  this.passEvents = [];
  this._passSeq = 0;
  // 人机（机器人）：只保留座位标记和接口，不做自动决策
  this._botTimer = null;
  this._botRunning = false;
  // 记牌：本局全场已出牌的点数计数（15 档）。保留为公开状态，便于后续扩展。
  this.playedCounts = newPlayedCounts();
  this.broadcast = function () {};   // 由 index.js 注入
  this._tick = 0;
  this.historyStore = opts.historyStore || null;
  this.cleanup = function () {};     // 由 index.js 注入
}

// 「全场已出牌」的点数计数（15 档，下标 = rank-3，即 3..17）。
// 目前人机不接入任何决策逻辑，仍保留这个公开状态给接口和后续扩展使用。
function newPlayedCounts() {
  var a = new Array(15);
  for (var i = 0; i < 15; i++) a[i] = 0;
  return a;
}

function historyCard(c) {
  if (!c) return null;
  return { id: c.id, rank: c.rank, suit: c.suit, label: c.label, color: c.color, isJoker: !!c.isJoker };
}

function historyInfo(info) {
  if (!info) return null;
  var out = {};
  Object.keys(info).forEach(function (key) {
    var value = info[key];
    if (typeof value !== 'function') out[key] = value;
  });
  return out;
}

function historySource(source) {
  if (!source) return { source: 'human' };
  if (typeof source === 'string') return { source: source };
  var out = {};
  Object.keys(source).forEach(function (key) { out[key] = source[key]; });
  if (!out.source) out.source = 'human';
  return out;
}

Room.prototype.historyObservation = function (seat) {
  var actor = this.players[seat];
  return {
    actorSeat: seat,
    actorNick: actor ? actor.nick : '',
    actorIsBot: !!(actor && actor.isBot),
    actorIsLandlord: !!(actor && actor.isLandlord),
    actorHand: actor ? (actor.hand || []).map(historyCard) : [],
    players: this.players.map(function (p) {
      return p ? {
        seat: p.seat, nick: p.nick, isBot: !!p.isBot, isLandlord: !!p.isLandlord,
        cardCount: (p.hand || []).length, score: String(p.score)
      } : null;
    }),
    phase: this.phase,
    currentTurnSeat: this.currentTurnSeat,
    landlordSeat: this.landlordSeat,
    lastPlay: this.lastPlay ? {
      seat: this.lastPlay.seat,
      cards: (this.lastPlay.cards || []).map(historyCard),
      info: historyInfo(this.lastPlay.info)
    } : null,
    canPass: this.lastPlay != null,
    passCount: this.passCount || 0,
    playedCounts: (this.playedCounts || []).slice(),
    bids: (this.bids || []).map(function (b) { return { seat: b.seat, val: b.val }; }),
    highestBid: this.highestBid || 0,
    highestBidderSeat: this.highestBidderSeat,
    revealChoice: this.revealChoice,
    multiplyChoices: Object.assign({}, this.multiplyChoices || {}),
    bombMult: this.bombMult || 1,
    deadlineRemainingMs: this.deadline ? Math.max(0, this.deadline - Date.now()) : null
  };
};

Room.prototype.recordDecision = function (event, seat, action, source) {
  if (!this.historyStore) return;
  this._roundActionCount = (this._roundActionCount || 0) + 1;
  this.historyStore.recordRound(this, event, {
    seat: seat,
    nick: this.players[seat] ? this.players[seat].nick : '',
    action: action,
    origin: historySource(source),
    observation: this.historyObservation(seat)
  });
};

Room.prototype.recordRoomEvent = function (event, data) {
  if (this.historyStore) this.historyStore.recordRoom(this, event, data || {});
};

// 状态变化后统一走这里：先广播给真人，再决定要不要让机器人行动。
// 之所以挂在「广播之后」，是因为服务端每个决策点的变化都会广播一次，
// 这里就是唯一的收口点，不用在每个流程分支里手写调度。
Room.prototype.notify = function () {
  this.broadcast();     // 注意：这里是注入的广播函数本体，不要再被批量替换成 notify
  this.maybeBot();
};

Room.prototype.nextSeat = function (seat) { return (seat + 3) % 4; };

Room.prototype.addPlayer = function (nick, isHost) {
  if (this.phase !== 'waiting') return { error: '房间已开始，无法加入' };
  if (this.players.some(function (p) { return p && p.nick === nick; })) return { error: '房间昵称已被使用，请更换' };
  var seat = -1;
  for (var i = 0; i < 4; i++) { if (!this.players[i]) { seat = i; break; } }
  if (seat === -1) return { error: '房间已满（4 人）' };
  var p = {
    seat: seat, nick: nick, isHost: !!isHost, isLandlord: false,
    ready: false, connected: false, hand: [], score: BigInt(0),
    exited: false, muted: false, stats: emptyStats()
  };
  this.players[seat] = p;
  if (isHost) this.hostSeat = seat;
  this.recordRoomEvent('player_joined', { seat: seat, nick: nick, isHost: !!isHost, isBot: false });
  return { player: p, seat: seat };
};

Room.prototype.getPlayer = function (nick) {
  for (var i = 0; i < 4; i++) { if (this.players[i] && this.players[i].nick === nick) return this.players[i]; }
  return null;
};

// ---------------- 人机（机器人）座位 ----------------
// 机器人昵称池：取自「小X」系列，重名时自动退到「机器人N」
var BOT_NAMES = ['小智', '小美', '小强', '小灵'];
var BOT_MAX = 3;   // 一桌最多 3 个人机，保证至少 1 个真人（纯人机局没有意义）

Room.prototype.botCount = function () {
  var n = 0;
  for (var i = 0; i < 4; i++) if (this.players[i] && this.players[i].isBot) n++;
  return n;
};

// 在指定座位放一个人机（仅房主、仅未开局）
Room.prototype.addBot = function (seat) {
  if (this.phase !== 'waiting') return { error: '仅未开局时可添加人机' };
  seat = Number(seat);
  if (!(seat >= 0 && seat <= 3)) return { error: '座位号不合法' };
  if (this.players[seat]) return { error: '该座位已经有人了' };
  if (this.botCount() >= BOT_MAX) return { error: '一桌最多 ' + BOT_MAX + ' 个人机' };
  var used = {};
  for (var i = 0; i < 4; i++) if (this.players[i]) used[this.players[i].nick] = 1;
  var nick = null;
  for (var j = 0; j < BOT_NAMES.length; j++) {
    if (!used[BOT_NAMES[j]]) { nick = BOT_NAMES[j]; break; }
  }
  if (!nick) { var k = 1; while (used['机器人' + k]) k++; nick = '机器人' + k; }
  this.players[seat] = {
    seat: seat, nick: nick, isHost: false, isLandlord: false,
    ready: true,                       // 人机默认已准备，房主点「开始游戏」就能开
    connected: true, hand: [], score: BigInt(0),
    exited: false, stats: emptyStats(), isBot: true
  };
  this.recordRoomEvent('player_joined', { seat: seat, nick: nick, isHost: false, isBot: true });
  this.notify();
  return { ok: true, seat: seat, nick: nick };
};

// 移除指定座位上的人机（仅房主、仅未开局）
Room.prototype.removeBot = function (seat) {
  if (this.phase !== 'waiting') return { error: '仅未开局时可移除人机' };
  seat = Number(seat);
  var p = this.players[seat];
  if (!p) return { error: '该座位是空的' };
  if (!p.isBot) return { error: '该座位不是人机' };
  this.recordRoomEvent('player_left', { seat: seat, nick: p.nick, isBot: true, reason: 'removed_by_host' });
  this.players[seat] = null;
  this.notify();
  return { ok: true };
};

Room.prototype.activeCount = function () {
  var n = 0;
  for (var i = 0; i < 4; i++) { if (this.players[i] && !this.players[i].exited) n++; }
  return n;
};

// ---------------- 客户端连接管理 ----------------
Room.prototype.addClient = function (nick, res) {
  if (!this.clients[nick]) this.clients[nick] = new Set();
  this.clients[nick].add(res);
  var p = this.getPlayer(nick);
  if (p) p.connected = true;
  // 重连恢复
  if (this.paused && this.pausedBy === nick) this.resume();
  this.notify();
};

Room.prototype.removeClient = function (nick, res) {
  if (this.clients[nick]) {
    this.clients[nick].delete(res);
    if (this.clients[nick].size === 0) delete this.clients[nick];
  }
  var p = this.getPlayer(nick);
  if (p) {
    p.connected = !!(this.clients[nick] && this.clients[nick].size > 0);
    if (p.connected === false && ['bidding', 'reveal', 'multiply', 'playing'].indexOf(this.phase) >= 0) {
      // 断线暂停，等待重连或房主解散
      if (!this.paused) { this.paused = true; this.pausedBy = nick; this.clearTimer(); this.notify(); }
    }
  }
};

Room.prototype.resume = function () {
  this.paused = false;
  this.pausedBy = null;
  if (this.phase === 'playing') {
    this.setPlayingTimer();
    this.notify();
    return;
  }
  var dur = this.config.choiceTimeout * 1000;
  if (this.phase === 'bidding') dur = this.config.bidTimeout * 1000;
  this.setTimer(dur, this.phaseTimeoutHandler());
  this.notify();
};

// ---------------- 定时器 ----------------
Room.prototype.setTimer = function (ms, fn) {
  this.clearTimer();
  this.deadline = Date.now() + ms;
  var self = this;
  this.timer = setTimeout(function () {
    self.timer = null; self.deadline = null;
    try { fn(); } catch (e) { console.error('timer error', e); }
  }, ms);
};
Room.prototype.clearTimer = function () {
  if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  if (this._cannotBeatTimer) { clearTimeout(this._cannotBeatTimer); this._cannotBeatTimer = null; }
  this.deadline = null;
};

Room.prototype.phaseTimeoutHandler = function () {
  var self = this;
  if (this.phase === 'bidding') return function () { self.onBidTimeout(); };
  if (this.phase === 'reveal') return function () { self.resolveReveal(false, 'timeout'); };
  if (this.phase === 'multiply') return function () { self.resolveMultiply('timeout'); };
  if (this.phase === 'playing') return function () { self.onPlayTimeout(); };
  return function () {};
};

// 每秒心跳：刷新倒计时（客户端凭 deadline 计算剩余）
Room.prototype.tick = function () {
  if (this.deadline && ['bidding', 'reveal', 'multiply', 'playing'].indexOf(this.phase) >= 0 && !this.paused) {
    this.notify();
  }
};

// ---------------- 人机自动驱动 ----------------
/*
 * 每个决策点（叫分 / 明牌 / 加倍 / 出牌）如果轮到人机，就排一次「思考延时」，
 * 到点后用 bot.js 的启发式做决策。调度只挂在 notify() 后面这一个收口点上，
 * 所以不用在每个流程分支里手写「轮到人机了没有」。
 * 两个防重入开关：
 *   _botTimer   —— 同时只存在一个「思考中」的定时器（每秒心跳广播不会重复排程）
 *   _botRunning —— 人机动作引发的广播不再排队新动作，动作落地后再统一排下一位
 */
Room.prototype.botActions = function () {
  var self = this, out = [];
  if (this.paused) return out;
  var i, p;
  if (this.phase === 'bidding') {
    var bs = this.bidOrder[this.bidIndex];
    p = this.players[bs];
    if (p && p.isBot) {
      out.push({ seat: bs, run: function () { self.submitBid(bs, Bot.chooseBid(p.hand, self.highestBid), 'bot'); } });
    }
  } else if (this.phase === 'reveal') {
    var ls = this.landlordSeat;
    p = this.players[ls];
    if (p && p.isBot && this.revealChoice == null) {
      out.push({ seat: ls, run: function () { self.submitReveal(ls, Bot.chooseReveal(p.hand), 'bot'); } });
    }
  } else if (this.phase === 'multiply') {
    // 加倍是全员同时选，所以一次可能有好几个人机要动，一起收下来
    for (i = 0; i < 4; i++) {
      p = this.players[i];
      if (!p || !p.isBot || this.multiplyChoices[i] != null) continue;
      (function (seat, pl) {
        out.push({ seat: seat, run: function () { self.submitMultiply(seat, Bot.chooseMultiply(pl.hand), 'bot'); } });
      })(i, p);
    }
  } else if (this.phase === 'playing') {
    var ts = this.currentTurnSeat;
    p = this.players[ts];
    if (p && (p.isBot || p.autoPlay)) out.push({ seat: ts, run: function () { self.botPlay(ts); } });
  }
  return out;
};

// 人机的「思考延时」。单独抽成方法是为了给测试留一个接缝
// （测试里覆写成 1~2ms 就能快速跑完整局），生产环境用 bot.js 的默认值。
Room.prototype.botThinkDelay = function () { return Bot.thinkDelay(this.phase); };

Room.prototype.maybeBot = function () {
  if (this._botTimer || this._botRunning || this.paused) return;
  var acts = this.botActions();
  if (!acts.length) return;
  var self = this;
  this._botTimer = setTimeout(function () {
    self._botTimer = null;
    if (self.paused) return;
    var again = self.botActions();
    if (!again.length) return;
    self._botRunning = true;
    try {
      if (self.phase === 'multiply') { for (var i = 0; i < again.length; i++) again[i].run(); }
      else again[0].run();
    } catch (e) {
      console.error('bot action error', e);
    } finally {
      self._botRunning = false;
    }
    self.maybeBot();          // 这步落地后再排下一位
  }, this.botThinkDelay());
};

// 人机出牌：先决策，再走 submitPlay 的服务端权威校验 ——
// 这样即使人机引擎有 bug，也只会被拒绝并走兜底，不会污染牌局状态。
Room.prototype.botPlay = function (seat) {
  var p = this.players[seat];
  if (!p || !(p.isBot || p.autoPlay) || this.phase !== 'playing' || seat !== this.currentTurnSeat) return;
  var decisionSource = p.autoPlay ? 'autoplay' : 'bot';
  var decisionSource = p.autoPlay ? 'autoplay' : 'bot';
  var decisionSource = p.autoPlay ? 'autoplay' : 'bot';
  var dec = this.recommendPlayForSeat(seat);
  if (dec && dec.cards && dec.cards.length) {
    var ids = dec.cards.map(function (c) { return c.id; });
    var r = this.submitPlay(seat, ids, decisionSource);
    if (!r || !r.error) return;
    console.error('bot play rejected:', r.error);
  }
  if (dec && dec.pass) { this.applyPass(seat, decisionSource); return; }
  // 兜底（决策异常 / 被规则拒绝）：按超时规则处理 —— 首出最小单张，否则过牌
  if (this.lastPlay == null) {
    var min = p.hand.slice().sort(function (a, b) { return a.rank - b.rank; })[0];
    if (min) { this.applyPlay(seat, [min], decisionSource); return; }
  }
  this.applyPass(seat, decisionSource);
};

Room.prototype.recommendPlayForSeat = function (seat) {
  var p = this.players[seat];
  if (!p || this.phase !== 'playing' || seat !== this.currentTurnSeat) return { error: '未轮到你出牌' };
  var counts = [0, 0, 0, 0];
  for (var i = 0; i < 4; i++) counts[i] = this.players[i] ? this.players[i].hand.length : 0;
  var dec = null;
  try {
    dec = Bot.choosePlay({
      hand: p.hand, lastPlay: this.lastPlay, mySeat: seat,
      landlordSeat: this.landlordSeat, isLandlord: !!p.isLandlord, counts: counts,
      playedCounts: this.playedCounts, consecutivePasses: this.passCount
    });
  } catch (e) { console.error('bot choosePlay error', e); dec = null; }
  if (dec && dec.cards && dec.cards.length) return { cards: dec.cards };
  if (this.lastPlay != null) return { pass: true };
  var min = p.hand.slice().sort(function (a, b) { return a.rank - b.rank; })[0];
  return min ? { cards: [min], fallback: true } : { pass: true };
};

Room.prototype.recommendPlay = function (nick) {
  var seat = this.seatOf(nick);
  var dec = this.recommendPlayForSeat(seat);
  if (dec.error) return dec;
  return {
    ok: true,
    pass: !!dec.pass,
    fallback: !!dec.fallback,
    cards: dec.cards ? dec.cards.map(function (c) { return c.id; }) : []
  };
};

Room.prototype.setAutoPlay = function (nick, enabled) {
  var p = this.getPlayer(nick);
  if (!p) return { error: '不在房间中' };
  if (p.isBot) return { error: '人机不需要托管' };
  p.autoPlay = !!enabled;
  this.recordRoomEvent('autoplay_changed', { seat: p.seat, nick: p.nick, enabled: p.autoPlay });
  this.notify();
  return { ok: true, autoPlay: p.autoPlay };
};

// ---------------- 房主操作 ----------------
Room.prototype.hostAction = function (nick, action, payload) {
  var p = this.getPlayer(nick);
  if (!p || !p.isHost) return { error: '仅房主可操作' };
  if (action === 'start') return this.start();
  if (action === 'addBot') return this.addBot(payload.seat);
  if (action === 'removeBot') return this.removeBot(payload.seat);
  if (action === 'kick') {
    var t = this.getPlayer(payload.targetNick || payload.nick);
    if (!t) return { error: '玩家不存在' };
    if (t.isHost) return { error: '不能踢房主' };
    if (t.isBot) return { error: '人机请在座位卡上移除' };
    this.recordRoomEvent('player_left', { seat: t.seat, nick: t.nick, isBot: false, reason: 'kicked' });
    this.players[t.seat] = null;
    this.notify();
    return { ok: true };
  }
  if (action === 'transfer') {
    var nt = this.getPlayer(payload.targetNick || payload.nick);
    if (!nt) return { error: '玩家不存在' };
    if (nt.isBot) return { error: '不能把房主转给人机' };
    this.players[this.hostSeat].isHost = false;
    nt.isHost = true; this.hostSeat = nt.seat;
    this.recordRoomEvent('host_transferred', { fromNick: p.nick, toNick: nt.nick, toSeat: nt.seat });
    this.persist();
    this.notify();
    return { ok: true };
  }
  if (action === 'mute') {
    var mt = this.getPlayer(payload.targetNick);
    if (!mt) return { error: '玩家不存在' };
    if (mt.isHost) return { error: '不能禁言房主' };
    if (mt.isBot) return { error: '人机不需要禁言' };
    mt.muted = !!payload.muted;
    this.recordRoomEvent('player_mute_changed', { seat: mt.seat, nick: mt.nick, muted: mt.muted });
    this.persist();
    this.notify();
    return { ok: true, muted: mt.muted };
  }
  if (action === 'settings') {
    var next = payload.config || {};
    var bidSeconds = parseInt(next.bidTimeout, 10);
    var choiceSeconds = parseInt(next.choiceTimeout, 10);
    var playSeconds = parseInt(next.playTimeout, 10);
    if (isNaN(bidSeconds)) bidSeconds = this.config.bidTimeout;
    if (isNaN(choiceSeconds)) choiceSeconds = this.config.choiceTimeout;
    if (isNaN(playSeconds)) playSeconds = this.config.playTimeout;
    this.config.bidTimeout = Math.min(30, Math.max(5, bidSeconds));
    this.config.choiceTimeout = Math.min(30, Math.max(5, choiceSeconds));
    this.config.playTimeout = Math.min(60, Math.max(5, playSeconds));
    this.config.dealMode = next.dealMode === 'random' ? 'random' : 'enhanced';
    this.recordRoomEvent('settings_changed', {
      bidTimeout: this.config.bidTimeout,
      choiceTimeout: this.config.choiceTimeout,
      playTimeout: this.config.playTimeout,
      dealMode: this.config.dealMode
    });
    this.persist();
    this.notify();
    return { ok: true, config: this.config };
  }
  if (action === 'dissolve') { this.endRoom(true); return { ok: true }; }
  if (action === 'config') {
    if (this.phase !== 'waiting') return { error: '仅未开局时可修改配置' };
    Object.assign(this.config, payload.config || {});
    this.totalRounds = this.config.totalRounds;
    this.notify();
    return { ok: true };
  }
  return { error: '未知操作' };
};

Room.prototype.start = function () {
  if (this.phase !== 'waiting') return { error: '游戏已在进行中' };
  if (this.activeCount() !== 4) return { error: '需要 4 名玩家才能开始' };
  this.round = 1;
  this.beginRound();
  return { ok: true };
};

Room.prototype.leave = function (nick) {
  var p = this.getPlayer(nick);
  if (!p) return { error: '不在房间中' };
  if (this.phase === 'waiting') {
    this.recordRoomEvent('player_left', { seat: p.seat, nick: p.nick, isBot: !!p.isBot, reason: 'left' });
    this.players[p.seat] = null;
    // 房主离开则转移：优先交给真人（转给人机会导致没人能点「开始游戏」）
    if (p.isHost) {
      var heir = -1;
      for (var i = 0; i < 4; i++) { if (this.players[i] && !this.players[i].isBot) { heir = i; break; } }
      if (heir < 0) for (var j = 0; j < 4; j++) { if (this.players[j]) { heir = j; break; } }
      if (heir >= 0) { this.players[heir].isHost = true; this.hostSeat = heir; }
    }
    this.notify();
    return { ok: true };
  }
  // 进行中离开：标记退出并暂停，等待房主解散
  this.recordRoomEvent('player_left', { seat: p.seat, nick: p.nick, isBot: !!p.isBot, reason: 'left_during_game' });
  p.exited = true; p.hand = [];
  if (!this.paused) { this.paused = true; this.pausedBy = nick; this.clearTimer(); }
  this.notify();
  return { ok: true };
};

// ---------------- 单局流程 ----------------
Room.prototype.beginRound = function () {
  if (this.activeCount() < 4) {
    this.paused = true; this.pausedBy = '__short__';
    this.broadcastSystem('人数不足 4 人，牌局暂停，请房主解散房间');
    this.notify();
    return;
  }
  for (var i = 0; i < 4; i++) {
    if (this.players[i]) { this.players[i].isLandlord = false; this.players[i].hand = []; }
  }
  var dealt = this.config.dealMode === 'random' ? DDZCards.randomDeal() : DDZCards.deal();
  for (var s = 0; s < 4; s++) { if (this.players[s]) this.players[s].hand = dealt.hands[s]; }
  this.bottom = dealt.bottom;
  this.bottomRevealed = false;
  this.lastPlay = null; this.lastPlaySeat = null; this.passCount = 0; this.history = [];
  this._roundActionCount = 0;
  this.playedCounts = newPlayedCounts();
  this.highestBid = 0; this.highestBidderSeat = null; this.bids = [];
  this.revealChoice = false; this.multiplyChoices = {};
  this.bombMult = 1; this.farmerPlayedCount = 0; this.landlordPlayCount = 0;

  // 叫分起始：首局随机；之后上一局赢家
  if (this.round === 1 || this.lastWinnerSeat == null) {
    this.bidStarterSeat = Math.floor(Math.random() * 4);
  } else {
    this.bidStarterSeat = this.lastWinnerSeat;
  }
  // 叫分和出牌统一按逆时针推进（starter, starter-1, starter-2, starter-3）。
  this.bidOrder = [0, 1, 2, 3].map(function (x) { return (this.bidStarterSeat - x + 4) % 4; }, this);
  this.bidIndex = 0;
  this.phase = 'bidding';
  if (this.historyStore) {
    this.historyStore.startRound(this, {
      config: {
        baseScore: this.config.baseScore,
        totalRounds: this.totalRounds,
        bidTimeout: this.config.bidTimeout,
        choiceTimeout: this.config.choiceTimeout,
        playTimeout: this.config.playTimeout,
        dealMode: this.config.dealMode,
        allowReveal: this.config.allowReveal,
        allowDouble: this.config.allowDouble,
        allowNegative: this.config.allowNegative
      },
      players: this.players.map(function (p) {
        return p ? { seat: p.seat, nick: p.nick, isHost: !!p.isHost, isBot: !!p.isBot, score: String(p.score) } : null;
      }),
      deal: {
        hands: this.players.map(function (p) { return p ? p.hand.map(historyCard) : []; }),
        bottom: this.bottom.map(historyCard),
        metadata: dealt.meta || { mode: 'random' }
      },
      bidStarterSeat: this.bidStarterSeat,
      bidOrder: this.bidOrder.slice(),
      direction: 'counterclockwise',
      rules: { deckCount: 2, playerCount: 4, cardsPerPlayer: 25, bottomCardCount: 8 }
    });
  }
  this.setTimer(this.config.bidTimeout * 1000, this.phaseTimeoutHandler());
  this.notify();
};

Room.prototype.onBidTimeout = function () { this.submitBid(this.bidOrder[this.bidIndex], 0, 'timeout'); };

Room.prototype.submitBid = function (seat, value, source) {
  if (this.phase !== 'bidding') return;
  if (seat !== this.bidOrder[this.bidIndex]) return;
  value = Number(value);
  if ([0, 1, 2, 3].indexOf(value) < 0) return;
  if (value !== 0 && value <= this.highestBid) return; // 必须高于当前最高分
  this.recordDecision('bid', seat, { value: value }, source);
  this.bids.push({ seat: seat, val: value });
  if (value > 0) { this.highestBid = value; this.highestBidderSeat = seat; }
  if (value === 3) { this.resolveBidding(); return; }
  this.bidIndex++;
  if (this.bidIndex >= 4) { this.resolveBidding(); return; }
  this.setTimer(this.config.bidTimeout * 1000, this.phaseTimeoutHandler());
  this.notify();
};

Room.prototype.resolveBidding = function () {
  if (this.highestBid > 0) {
    this.setLandlord(this.highestBidderSeat);
  } else {
    // 流局：重新发牌，不结算、不计局
    if (this.historyStore) this.historyStore.abortRound(this, 'no_bid', { bids: this.bids.slice() });
    this.broadcastSystem('本局无人叫分，流局，重新发牌');
    this.beginRound();
  }
};

Room.prototype.setLandlord = function (seat) {
  this.landlordSeat = seat;
  var p = this.players[seat];
  p.isLandlord = true;
  p.hand = p.hand.concat(this.bottom);
  DDZCards.sortHand(p.hand);
  this.bottomRevealed = true;
  if (this.historyStore) this.historyStore.recordRound(this, 'landlord_assigned', {
    seat: seat, nick: p.nick, highestBid: this.highestBid,
    bottom: this.bottom.map(historyCard), landlordHand: p.hand.map(historyCard)
  });
  if (this.config.allowReveal) {
    this.phase = 'reveal';
    this.revealChoice = null;
    this.setTimer(this.config.choiceTimeout * 1000, this.phaseTimeoutHandler());
    this.notify();
  } else {
    this.revealChoice = false;
    this.enterMultiply();
  }
};

Room.prototype.submitReveal = function (seat, reveal, source) {
  if (this.phase !== 'reveal' || seat !== this.landlordSeat) return;
  this.resolveReveal(!!reveal, source);
};
Room.prototype.resolveReveal = function (reveal, source) {
  this.recordDecision('reveal', this.landlordSeat, { reveal: !!reveal }, source);
  this.revealChoice = reveal;
  this.enterMultiply();
};

Room.prototype.enterMultiply = function () {
  if (this.config.allowDouble) {
    this.phase = 'multiply';
    this.multiplyChoices = {};
    this.setTimer(this.config.choiceTimeout * 1000, this.phaseTimeoutHandler());
    this.notify();
  } else {
    this.multiplyChoices = {};
    this.beginPlaying();
  }
};

Room.prototype.submitMultiply = function (seat, mult, source) {
  if (this.phase !== 'multiply') return;
  if (this.multiplyChoices[seat] != null) return;
  mult = Number(mult);
  if (mult !== 1 && mult !== 2 && mult !== 4) mult = 1;
  this.recordDecision('multiply', seat, { multiplier: mult }, source);
  this.multiplyChoices[seat] = mult;
  // 同时加倍：所有人都能随时选，不用排队；等「在局玩家」都选完就立刻进入出牌阶段
  var need = 0, got = 0;
  for (var i = 0; i < 4; i++) { if (this.players[i] && !this.players[i].exited) need++; }
  for (var k in this.multiplyChoices) {
    if (!this.multiplyChoices.hasOwnProperty(k)) continue;
    var pk = this.players[k];
    if (pk && !pk.exited) got++;
  }
  if (got >= need) { this.resolveMultiply(); return; }
  this.notify();
};
Room.prototype.resolveMultiply = function (source) {
  for (var i = 0; i < 4; i++) {
    if (this.players[i] && this.multiplyChoices[i] == null) {
      this.recordDecision('multiply', i, { multiplier: 1 }, source || 'timeout');
      this.multiplyChoices[i] = 1;
    }
  }
  this.beginPlaying();
};

Room.prototype.beginPlaying = function () {
  this.phase = 'playing';
  this.currentTurnSeat = this.landlordSeat;
  this.lastPlay = null; this.lastPlaySeat = null; this.passCount = 0;
  this.bombMult = 1; this.farmerPlayedCount = 0; this.landlordPlayCount = 0;
  this.setPlayingTimer();
  this.notify();
};
Room.prototype.setPlayingTimer = function () {
  this.setTimer(this.config.playTimeout * 1000, this.phaseTimeoutHandler());
  var seat = this.currentTurnSeat;
  var player = this.players[seat];
  if (!this.lastPlay || !player || DDZRules.canBeatWithHand(player.hand, this.lastPlay.info)) return;
  var self = this;
  var expectedPlaySeat = this.lastPlaySeat;
  var expectedCards = this.lastPlay.cards.map(function (c) { return c.id; }).sort().join(',');
  this._cannotBeatTimer = setTimeout(function () {
    self._cannotBeatTimer = null;
    if (self.paused || self.phase !== 'playing' || self.currentTurnSeat !== seat || !self.lastPlay) return;
    var currentCards = self.lastPlay.cards.map(function (c) { return c.id; }).sort().join(',');
    if (self.lastPlaySeat !== expectedPlaySeat || currentCards !== expectedCards) return;
    self.submitPass(seat, 'auto_cannot_beat');
  }, this.cannotBeatDelay());
};
Room.prototype.cannotBeatDelay = function () { return 5000; };
Room.prototype.onPlayTimeout = function () {
  var seat = this.currentTurnSeat;
  var p = this.players[seat];
  if (!p) return;
  if (this.lastPlay == null) {
    // 自由出牌超时：自动出最小单张
    var min = p.hand.slice().sort(function (a, b) { return a.rank - b.rank; })[0];
    if (min) this.applyPlay(seat, [min], 'timeout');
  } else {
    this.applyPass(seat, 'timeout');
  }
};

Room.prototype.submitPlay = function (seat, cardIds, source) {
  if (this.phase !== 'playing' || seat !== this.currentTurnSeat) return { error: '未轮到你出牌' };
  var p = this.players[seat];
  var set = {};
  cardIds.forEach(function (id) { set[id] = true; });
  if (Object.keys(set).length !== cardIds.length) return { error: '重复选牌' };
  var cards = [];
  for (var i = 0; i < p.hand.length; i++) { if (set[p.hand[i].id]) cards.push(p.hand[i]); }
  if (cards.length !== cardIds.length) return { error: '手牌中不存在所选牌' };
  var info = DDZRules.analyze(cards);
  if (!info) return { error: '牌型不合法' };
  if (this.lastPlay && !DDZRules.beats(info, this.lastPlay.info)) return { error: '管不上上家的牌' };
  this.applyPlay(seat, cards, source);
  return { ok: true };
};

Room.prototype.applyPlay = function (seat, cards, source) {
  var p = this.players[seat];
  var info = DDZRules.analyze(cards);
  this.recordDecision('play', seat, {
    cards: cards.map(historyCard),
    cardIds: cards.map(function (c) { return c.id; }),
    info: historyInfo(info)
  }, source);
  var set = {}; cards.forEach(function (c) { set[c.id] = true; });
  p.hand = p.hand.filter(function (c) { return !set[c.id]; });
  if (info.type === 'bomb' || info.type === 'rocket') {
    this.bombMult *= info.bombMult;
    if (info.type === 'rocket') p.stats.rocketCount++; else p.stats.bombCount++;
  }
  if (p.isLandlord) this.landlordPlayCount++; else this.farmerPlayedCount++;
  // 记牌：出掉的牌按点数累加（王 16/17 也算），保留为公开状态
  for (var pc = 0; pc < cards.length; pc++) {
    var pr = cards[pc].rank;
    if (pr >= 3 && pr <= 17) this.playedCounts[pr - 3]++;
  }
  this.lastPlay = { seat: seat, cards: cards, info: info };
  this.lastPlaySeat = seat;
  this.passCount = 0;
  this.history.push({ seat: seat, cards: cards, info: info });
  if (p.hand.length === 0) { this.endRound(seat); return; }
  this.advanceTurn();
};

Room.prototype.submitPass = function (seat, source) {
  if (this.phase !== 'playing' || seat !== this.currentTurnSeat) return { error: '未轮到你' };
  if (this.lastPlay == null) return { error: '你是首出，必须出牌' };
  this.applyPass(seat, source);
  return { ok: true };
};
Room.prototype.applyPass = function (seat, source) {
  var pp = this.players[seat];
  this.recordDecision('pass', seat, { pass: true }, source);
  // 记一条过牌事件（id 全局递增、跨局不清零），客户端据此播“不要”并显示气泡
  this.passEvents.push({ id: ++this._passSeq, seat: seat, nick: pp ? pp.nick : '' });
  if (this.passEvents.length > 40) this.passEvents = this.passEvents.slice(-40);
  this.passCount++;
  if (this.passCount >= 3) {
    // 三家全过，最后出牌者获得新一轮自由出牌权
    this.currentTurnSeat = this.lastPlaySeat;
    this.lastPlay = null;
    this.passCount = 0;
  } else {
    this.currentTurnSeat = this.nextSeat(this.currentTurnSeat);
  }
  this.setPlayingTimer();
  this.notify();
};
Room.prototype.advanceTurn = function () {
  this.currentTurnSeat = this.nextSeat(this.currentTurnSeat);
  this.setPlayingTimer();
  this.notify();
};

Room.prototype.endRound = function (winnerSeat) {
  var landlordWin = !!(this.players[winnerSeat] && this.players[winnerSeat].isLandlord);
  var C = this.highestBid || 1;
  var D = this.bombMult;
  var E = 1;
  if (landlordWin && this.farmerPlayedCount === 0) E = 2;       // 春天
  if (!landlordWin && this.landlordPlayCount === 1) E = 2;       // 反春
  var M = this.revealChoice ? 2 : 1;
  var X = 1;
  for (var i = 0; i < 4; i++) { if (this.players[i]) X *= (this.multiplyChoices[i] || 1); }
  var totalMult = BigInt(C) * BigInt(D) * BigInt(E) * BigInt(M) * BigInt(X);
  var single = BigInt(this.config.baseScore) * totalMult;

  var deltas = {};
  var scoresAfter = {};
  var remainingHands = {};
  for (var s = 0; s < 4; s++) {
    var p = this.players[s];
    if (!p) continue;
    remainingHands[s] = p.hand.slice();
    var onWinSide = (p.isLandlord === landlordWin);
    var delta;
    if (landlordWin) { delta = p.isLandlord ? single * BigInt(3) : -single; }
    else { delta = p.isLandlord ? -(single * BigInt(3)) : single; }
    p.score += delta;
    deltas[s] = delta.toString();
    scoresAfter[s] = p.score.toString();
    // 统计
    p.stats.total++;
    if (onWinSide) { p.stats.win++; if (p.isLandlord) p.stats.landlordWin++; else p.stats.farmerWin++; }
    else { p.stats.lose++; }
    if (E === 2 && onWinSide) p.stats.springCount++;
    if (totalMult > p.stats.maxMult) p.stats.maxMult = Number(totalMult);
    if (single > BigInt(p.stats.maxScore)) p.stats.maxScore = single.toString();
  }

  this.lastWinnerSeat = winnerSeat;
  this.lastWinnerIsLandlord = landlordWin;
  this.settleInfo = {
    winnerSeat: winnerSeat, landlordWin: landlordWin,
    landlordNick: this.players[this.landlordSeat] ? this.players[this.landlordSeat].nick : '',
    winnerNick: this.players[winnerSeat] ? this.players[winnerSeat].nick : '',
    spring: E === 2,
    breakdown: { C: C, D: D, E: E, M: M, X: X, totalMult: totalMult.toString(), single: single.toString() },
    deltas: deltas, scoresAfter: scoresAfter, remainingHands: remainingHands,
    history: this.history.map(function (h) {
      return { seat: h.seat, nick: this.players[h.seat] ? this.players[h.seat].nick : '', type: h.info.type, count: h.cards.length };
    }, this)
  };
  this.phase = 'settle';
  if (this.historyStore) this.historyStore.endRound(this, {
    winnerSeat: winnerSeat,
    winnerNick: this.players[winnerSeat] ? this.players[winnerSeat].nick : '',
    landlordSeat: this.landlordSeat,
    landlordWin: landlordWin,
    spring: E === 2,
    breakdown: this.settleInfo.breakdown,
    deltas: deltas,
    scoresAfter: scoresAfter,
    remainingHands: Object.keys(remainingHands).reduce(function (out, key) {
      out[key] = remainingHands[key].map(historyCard); return out;
    }, {}),
    actionCount: this._roundActionCount || 0
  });
  this.clearTimer();
  this.persist();
  this.notify();
  var self = this;
  this.setTimer(9000, function () { self.advanceRound(); });
};

Room.prototype.advanceRound = function () {
  if (this.round < this.totalRounds) { this.round++; this.beginRound(); }
  else { this.endRoom(false); }
};

Room.prototype.endRoom = function (dissolved) {
  this.phase = 'roomEnd';
  this.clearTimer();
  this.finalBoard = this.buildFinalBoard();
  if (this.historyStore) this.historyStore.endRoom(this, {
    dissolved: !!dissolved,
    completedRounds: this.round,
    finalBoard: this.finalBoard
  });
  this.notify();
  var self = this;
  // 稍后清理房间与临时文件
  setTimeout(function () { self.cleanup(); }, 1500);
};

Room.prototype.buildFinalBoard = function () {
  var list = [];
  for (var i = 0; i < 4; i++) {
    var p = this.players[i];
    if (!p) continue;
    list.push({
      seat: p.seat, nick: p.nick, isHost: p.isHost, score: p.score.toString(),
      isBot: !!p.isBot,
      win: p.stats.win, lose: p.stats.lose, total: p.stats.total,
      winRate: p.stats.total ? (p.stats.win / p.stats.total) : 0,
      landlordWin: p.stats.landlordWin, farmerWin: p.stats.farmerWin,
      bombCount: p.stats.bombCount, rocketCount: p.stats.rocketCount,
      springCount: p.stats.springCount, maxMult: p.stats.maxMult, maxScore: p.stats.maxScore,
      exited: p.exited
    });
  }
  list.sort(function (a, b) {
    if (a.score !== b.score) return BigInt(b.score) < BigInt(a.score) ? -1 : 1;
    if (b.win !== a.win) return b.win - a.win;
    return b.winRate - a.winRate;
  });
  return list;
};

// ---------------- 快照（按昵称个性化） ----------------
Room.prototype.getState = function (nick) {
  var self = this;
  var players = [];
  for (var i = 0; i < 4; i++) {
    var p = this.players[i];
    if (!p) { players.push(null); continue; }
    var showHand = (p.nick === nick) || (this.revealChoice && p.isLandlord);
    players.push({
      seat: p.seat, nick: p.nick, isHost: p.isHost, isLandlord: p.isLandlord,
      ready: p.ready, connected: p.connected, cardCount: p.hand.length,
      score: p.score.toString(), stats: p.stats, exited: p.exited,
      isBot: !!p.isBot, autoPlay: !!p.autoPlay, muted: !!p.muted,
      hand: showHand ? p.hand : null,
      // 本局公开状态：叫分 / 加倍选择 / 是否明牌（供所有人在其座位旁显示）
      bid: this.bidValueOf(p.seat),
      mult: (this.multiplyChoices && this.multiplyChoices[p.seat] != null) ? this.multiplyChoices[p.seat] : null,
      reveal: p.isLandlord ? this.revealChoice : null
    });
  }
  var state = {
    type: 'state', roomNo: this.roomNo, name: this.name,
    config: {
      baseScore: this.config.baseScore, totalRounds: this.totalRounds,
      bidTimeout: this.config.bidTimeout, choiceTimeout: this.config.choiceTimeout,
      playTimeout: this.config.playTimeout, dealMode: this.config.dealMode,
      allowReveal: this.config.allowReveal,
      allowDouble: this.config.allowDouble, allowNegative: this.config.allowNegative,
      hasPassword: !!this.config.password
    },
    phase: this.phase, round: this.round, totalRounds: this.totalRounds,
    hostSeat: this.hostSeat, paused: this.paused, pausedBy: this.pausedBy,
    players: players, you: nick,
    bottom: this.bottomRevealed ? this.bottom : null,
    currentTurnSeat: this.currentTurnSeat,
    deadline: this.deadline,
    multiplier: this.currentMultiplier(),
    // 局内互动（表情/道具/快捷语）与系统提示：客户端按 id 增量处理
    interactions: this.interactions || [],
    // 过牌事件（谁过了牌）：客户端按 id 增量播报“不要”
    passes: this.passEvents || []
  };
  if (this.phase === 'bidding') {
    state.bid = {
      starter: this.bidStarterSeat, highest: this.highestBid, highestSeat: this.highestBidderSeat,
      currentSeat: this.bidOrder[this.bidIndex], yourTurn: this.bidOrder[this.bidIndex] === this.seatOf(nick),
      bids: this.bids
    };
  }
  if (this.phase === 'reveal') {
    state.reveal = { landlordSeat: this.landlordSeat, yourTurn: this.landlordSeat === this.seatOf(nick), choice: this.revealChoice };
  }
  if (this.phase === 'multiply') {
    state.multiply = { yourTurn: true, choices: this.multiplyChoices };
  }
  if (this.phase === 'playing' || this.phase === 'settle') {
    state.play = {
      lastPlaySeat: this.lastPlaySeat,
      lastPlay: this.lastPlay ? { seat: this.lastPlay.seat, cards: this.lastPlay.cards, info: this.lastPlay.info } : null,
      canPass: this.lastPlay != null,
      yourTurn: this.currentTurnSeat === this.seatOf(nick)
    };
  }
  if (this.phase === 'settle' || this.phase === 'roomEnd') {
    state.settle = this.settleInfo;
  }
  if (this.phase === 'roomEnd') {
    state.finalBoard = this.finalBoard;
  }
  if (this.systemMsg) state.systemMsg = this.systemMsg;
  return state;
};

Room.prototype.seatOf = function (nick) {
  var p = this.getPlayer(nick); return p ? p.seat : -1;
};

// ---------------- 局内互动（表情 / 道具 / 快捷语） ----------------
// 道具类互动（需要指定目标玩家）：与前端 public/js/app.js 的 ITEMS 表保持一致
var INTERACT_ITEMS = {
  egg: 1, tomato: 1, cabbage: 1, slipper: 1, poop: 1, ice: 1, water: 1, firecracker: 1,
  flower: 1, gift: 1, beer: 1, kiss: 1, diamond: 1, crown: 1
};
var INTERACT_KINDS = { emoji: 1, chat: 1 };
for (var _ik in INTERACT_ITEMS) INTERACT_KINDS[_ik] = 1;
var INTERACT_MAX = 40;

Room.prototype.interact = function (seat, kind, value, targetSeat, itemCount) {
  if (!INTERACT_KINDS[kind]) return { error: '不支持的互动类型' };
  var p = this.players[seat];
  if (!p) return { error: '玩家不存在' };
  if (p.muted) return { error: '你已被房主禁言' };
  var now = Date.now();
  if (this._lastInteractAt[seat] && now - this._lastInteractAt[seat] < 400) return { error: '发送太快了，缓一缓' };
  this._lastInteractAt[seat] = now;
  var text = String(value == null ? '' : value).slice(0, 80);
  var count = 1;
  var tSeat = null;
  if (INTERACT_ITEMS[kind]) {
    tSeat = Number(targetSeat);
    if (isNaN(tSeat) || !this.players[tSeat] || tSeat === seat) return { error: '请选择其他玩家作为目标' };
    count = itemCount != null ? Number(itemCount) : (value && typeof value === 'object' ? Number(value.count) : Number(value));
    count = count === 10 ? 10 : 1;
    text = '';
  }
  this.interactions.push({
    id: ++this._interactSeq, seat: seat, nick: p.nick,
    kind: kind, value: text, target: tSeat, count: count, ts: now
  });
  if (this.interactions.length > INTERACT_MAX) {
    this.interactions = this.interactions.slice(-INTERACT_MAX);
  }
  this.notify();
  return { ok: true, id: this._interactSeq };
};

// 某座位本局的叫分（未叫过返回 null）
Room.prototype.bidValueOf = function (seat) {
  if (!this.bids) return null;
  for (var i = 0; i < this.bids.length; i++) { if (this.bids[i].seat === seat) return this.bids[i].val; }
  return null;
};
Room.prototype.currentMultiplier = function () {
  var C = this.highestBid || 0;
  var D = this.bombMult || 1;
  var M = this.revealChoice ? 2 : 1;
  var X = 1;
  for (var i = 0; i < 4; i++) { if (this.players[i] && this.multiplyChoices && this.multiplyChoices[i] != null) X *= this.multiplyChoices[i]; }
  return { C: C, D: D, M: M, X: X, total: C * D * M * X };
};

Room.prototype.broadcastSystem = function (msg) { this.systemMsg = msg; };
Room.prototype.clearSystem = function () { this.systemMsg = null; };

// ---------------- 临时文件持久化 ----------------
Room.prototype.persist = function () {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    var snap = {
      roomNo: this.roomNo, name: this.name, config: this.config,
      round: this.round, players: this.players.map(function (p) {
        return p ? { nick: p.nick, seat: p.seat, isHost: p.isHost, score: p.score.toString(), stats: p.stats, exited: p.exited, muted: !!p.muted } : null;
      })
    };
    fs.writeFileSync(path.join(DATA_DIR, 'room_' + this.roomNo + '.json'), JSON.stringify(snap));
  } catch (e) { /* 临时文件失败不影响游戏 */ }
};
Room.prototype.deleteData = function () {
  try { fs.unlinkSync(path.join(DATA_DIR, 'room_' + this.roomNo + '.json')); } catch (e) {}
};

module.exports = { Room: Room, genRoomNo: genRoomNo, DATA_DIR: DATA_DIR };
