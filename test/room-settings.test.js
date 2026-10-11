'use strict';

var assert = require('assert');
var Room = require('../server/room.js').Room;

function card(id, rank) {
  return { id: id, rank: rank, suit: '♠', label: String(rank), color: 'black', isJoker: false };
}

function makeRoom() {
  var room = new Room({ config: { playTimeout: 60 } });
  room.broadcast = function () {};
  room.persist = function () {};
  ['房主', '玩家甲', '玩家乙', '玩家丙'].forEach(function (nick, i) { room.addPlayer(nick, i === 0); });
  return room;
}

async function run() {
  var room = makeRoom();
  var changed = room.hostAction('房主', 'settings', {
    config: { bidTimeout: 12, choiceTimeout: 14, playTimeout: 45, dealMode: 'random' }
  });
  assert.strictEqual(changed.ok, true);
  assert.strictEqual(room.config.bidTimeout, 12);
  assert.strictEqual(room.config.choiceTimeout, 14);
  assert.strictEqual(room.config.playTimeout, 45);
  assert.strictEqual(room.config.dealMode, 'random');
  room.hostAction('房主', 'settings', { config: { bidTimeout: 0, choiceTimeout: 99, playTimeout: 999, dealMode: 'enhanced' } });
  assert.strictEqual(room.config.bidTimeout, 5);
  assert.strictEqual(room.config.choiceTimeout, 30);
  assert.strictEqual(room.config.playTimeout, 60);
  assert.strictEqual(room.config.dealMode, 'enhanced');

  assert.strictEqual(room.hostAction('房主', 'mute', { targetNick: '玩家甲', muted: true }).ok, true);
  assert.strictEqual(room.interact(1, 'emoji', '😀').error, '你已被房主禁言');
  assert.strictEqual(room.hostAction('房主', 'transfer', { targetNick: '玩家乙' }).ok, true);
  assert.strictEqual(room.players[2].isHost, true);
  assert(room.hostAction('房主', 'settings', { config: {} }).error, '旧房主不能继续修改设置');

  var timed = makeRoom();
  timed.phase = 'playing';
  timed.currentTurnSeat = 0;
  timed.players[0].hand = [card('low', 3)];
  timed.players[3].hand = [card('hi1', 10), card('hi2', 10)];
  timed.lastPlaySeat = 1;
  timed.lastPlay = {
    seat: 1,
    cards: [card('last1', 8), card('last2', 8)],
    info: { type: 'pair', main: 8, len: 2 }
  };
  timed.cannotBeatDelay = function () { return 20; };
  timed.setPlayingTimer();
  await new Promise(function (resolve) { setTimeout(resolve, 50); });
  assert.strictEqual(timed.passEvents.length, 1, '要不起时应自动产生一次过牌');
  assert.strictEqual(timed.passEvents[0].seat, 0);
  assert.strictEqual(timed.currentTurnSeat, 3, '自动过牌后应按逆时针轮到下一家');
  timed.clearTimer();

  console.log('room settings / mute / 5-second auto-pass tests passed');
}

run().catch(function (err) { console.error(err); process.exit(1); });
