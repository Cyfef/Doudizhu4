'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var Room = require('../server/room.js').Room;
var HistoryStore = require('../server/history-store.js').HistoryStore;

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

var tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ddz-history-test-'));
try {
  var store = new HistoryStore({ root: tempRoot });
  var room = new Room({ name: '历史测试', config: { totalRounds: 1, playTimeout: 60, dealMode: 'random' } });
  room.broadcast = function () {};
  room.persist = function () {};
  ['甲', '乙', '丙', '丁'].forEach(function (nick, i) { room.addPlayer(nick, i === 0); });
  room.historyStore = store;
  store.startRoom(room);

  assert.strictEqual(room.start().ok, true);
  var bidder = room.bidOrder[0];
  room.submitBid(bidder, 3, 'human');
  room.submitReveal(bidder, false, 'human');
  for (var seat = 0; seat < 4; seat++) room.submitMultiply(seat, 1, 'human');
  assert.strictEqual(room.phase, 'playing');

  var actor = room.currentTurnSeat;
  var chosen = room.players[actor].hand[0];
  assert.strictEqual(room.submitPlay(actor, [chosen.id], 'human').ok, true);
  var passer = room.currentTurnSeat;
  assert.strictEqual(room.submitPass(passer, 'human').ok, true);
  room.endRound(actor);
  room.clearTimer();
  store.endRoom(room, { dissolved: false, completedRounds: 1, finalBoard: room.buildFinalBoard() });

  var sessionPath = store.getSessionPath(room);
  assert(sessionPath && fs.existsSync(sessionPath));
  var meta = JSON.parse(fs.readFileSync(path.join(sessionPath, 'meta.json'), 'utf8'));
  assert.strictEqual(meta.schemaVersion, 'ddz4-expert-v1');
  assert.strictEqual(meta.config.password, undefined, '历史元数据不得保存密码');

  var roundFile = fs.readdirSync(sessionPath).filter(function (name) { return /^round_.*\.jsonl$/.test(name); })[0];
  var events = readJsonl(path.join(sessionPath, roundFile));
  var names = events.map(function (e) { return e.event; });
  ['round_started', 'bid', 'landlord_assigned', 'reveal', 'multiply', 'play', 'pass', 'round_ended'].forEach(function (name) {
    assert(names.indexOf(name) >= 0, '缺少历史事件：' + name);
  });

  var started = events.filter(function (e) { return e.event === 'round_started'; })[0];
  assert.strictEqual(started.data.deal.hands.length, 4);
  assert(started.data.deal.hands.every(function (hand) { return hand.length === 25; }));
  assert.strictEqual(started.data.deal.bottom.length, 8);
  assert.strictEqual(started.data.direction, 'counterclockwise');

  var play = events.filter(function (e) { return e.event === 'play'; })[0];
  assert.strictEqual(play.data.origin.source, 'human');
  assert.strictEqual(play.data.action.cardIds[0], chosen.id);
  assert(play.data.observation.actorHand.some(function (c) { return c.id === chosen.id; }), '动作前观察应包含被打出的牌');
  assert.strictEqual(play.data.observation.currentTurnSeat, actor);
  assert(events.every(function (e, i) { return i === 0 || e.sequence > events[i - 1].sequence; }), '事件序号必须严格递增');

  console.log('history store expert-data tests passed');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
