/*
 * history-store.js — 对局专家数据持久化组件
 *
 * 目录结构：
 *   server/history/<roomNo>/<sessionId>/meta.json
 *   server/history/<roomNo>/<sessionId>/room.jsonl
 *   server/history/<roomNo>/<sessionId>/round_0001_attempt_0001.jsonl
 *
 * JSONL 每行都是一条完整 JSON 事件。同步追加保证事件顺序稳定，并尽可能让
 * 已发生的动作在服务器异常退出时仍留在磁盘。可用 DDZ_HISTORY_DIR 改存储目录，
 * 或用 DDZ_HISTORY_ENABLED=0 关闭记录。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var SCHEMA_VERSION = 'ddz4-expert-v1';

function safePart(value) {
  return String(value == null ? '' : value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown';
}

function pad(n, width) {
  var s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}

function json(value, pretty) {
  return JSON.stringify(value, function (_key, item) {
    return typeof item === 'bigint' ? item.toString() : item;
  }, pretty ? 2 : 0);
}

function publicConfig(room) {
  var c = room.config || {};
  return {
    baseScore: c.baseScore,
    totalRounds: c.totalRounds,
    bidTimeout: c.bidTimeout,
    choiceTimeout: c.choiceTimeout,
    playTimeout: c.playTimeout,
    dealMode: c.dealMode,
    allowReveal: c.allowReveal,
    allowDouble: c.allowDouble,
    allowNegative: c.allowNegative,
    hasPassword: !!c.password
  };
}

function playerMeta(p) {
  if (!p) return null;
  return {
    seat: p.seat,
    nick: p.nick,
    isHost: !!p.isHost,
    isBot: !!p.isBot,
    isLandlord: !!p.isLandlord,
    score: p.score != null ? String(p.score) : '0'
  };
}

function sessionId() {
  var stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  var rand;
  try { rand = crypto.randomBytes(4).toString('hex'); }
  catch (e) { rand = Math.random().toString(16).slice(2, 10); }
  return stamp + '_' + rand;
}

function HistoryStore(opts) {
  opts = opts || {};
  this.root = opts.root || process.env.DDZ_HISTORY_DIR || path.join(__dirname, 'history');
  this.enabled = opts.enabled !== false && process.env.DDZ_HISTORY_ENABLED !== '0';
  this.states = new WeakMap();
  this._warned = false;
}

HistoryStore.prototype._safe = function (fn) {
  if (!this.enabled) return null;
  try { return fn(); }
  catch (e) {
    if (!this._warned) {
      this._warned = true;
      console.error('[history] 对局历史写入失败：', e && e.message);
    }
    return null;
  }
};

HistoryStore.prototype._append = function (file, event) {
  fs.appendFileSync(file, json(event, false) + '\n', 'utf8');
};

HistoryStore.prototype._envelope = function (room, state, event, data, scope) {
  state.sequence++;
  var now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: state.sessionId + '-' + pad(state.sequence, 8),
    sequence: state.sequence,
    timestamp: new Date(now).toISOString(),
    timestampMs: now,
    scope: scope,
    event: event,
    roomNo: room.roomNo,
    roomSessionId: state.sessionId,
    round: room.round || 0,
    roundAttempt: state.roundAttempt || 0,
    phase: room.phase,
    data: data || {}
  };
};

HistoryStore.prototype.startRoom = function (room) {
  var self = this;
  return this._safe(function () {
    var sid = sessionId();
    var dir = path.join(self.root, safePart(room.roomNo), sid);
    fs.mkdirSync(dir, { recursive: true });
    var state = {
      sessionId: sid,
      dir: dir,
      roomFile: path.join(dir, 'room.jsonl'),
      roundFile: null,
      roundAttempt: 0,
      lastRound: null,
      sequence: 0,
      roundOpen: false
    };
    self.states.set(room, state);
    fs.writeFileSync(path.join(dir, 'meta.json'), json({
      schemaVersion: SCHEMA_VERSION,
      roomNo: room.roomNo,
      roomSessionId: sid,
      name: room.name,
      createdAt: new Date().toISOString(),
      config: publicConfig(room),
      players: (room.players || []).map(playerMeta)
    }, true), 'utf8');
    self._append(state.roomFile, self._envelope(room, state, 'room_started', {
      name: room.name,
      config: publicConfig(room),
      players: (room.players || []).map(playerMeta)
    }, 'room'));
    return sid;
  });
};

HistoryStore.prototype._state = function (room) {
  var state = this.states.get(room);
  if (!state) {
    this.startRoom(room);
    state = this.states.get(room);
  }
  return state;
};

HistoryStore.prototype.recordRoom = function (room, event, data) {
  var self = this;
  this._safe(function () {
    var state = self._state(room); if (!state) return;
    self._append(state.roomFile, self._envelope(room, state, event, data, 'room'));
  });
};

HistoryStore.prototype.startRound = function (room, data) {
  var self = this;
  this._safe(function () {
    var state = self._state(room); if (!state) return;
    if (state.roundOpen) {
      self._append(state.roundFile, self._envelope(room, state, 'round_aborted', { reason: 'redeal' }, 'round'));
    }
    if (state.lastRound !== room.round) { state.lastRound = room.round; state.roundAttempt = 0; }
    state.roundAttempt++;
    state.roundFile = path.join(state.dir, 'round_' + pad(room.round || 0, 4)
      + '_attempt_' + pad(state.roundAttempt, 4) + '.jsonl');
    state.roundOpen = true;
    self._append(state.roundFile, self._envelope(room, state, 'round_started', data, 'round'));
  });
};

HistoryStore.prototype.recordRound = function (room, event, data) {
  var self = this;
  this._safe(function () {
    var state = self._state(room); if (!state || !state.roundFile) return;
    self._append(state.roundFile, self._envelope(room, state, event, data, 'round'));
  });
};

HistoryStore.prototype.abortRound = function (room, reason, data) {
  var self = this;
  this._safe(function () {
    var state = self._state(room); if (!state || !state.roundFile || !state.roundOpen) return;
    var payload = Object.assign({ reason: reason || 'aborted' }, data || {});
    self._append(state.roundFile, self._envelope(room, state, 'round_aborted', payload, 'round'));
    state.roundOpen = false;
  });
};

HistoryStore.prototype.endRound = function (room, data) {
  var self = this;
  this._safe(function () {
    var state = self._state(room); if (!state || !state.roundFile || !state.roundOpen) return;
    self._append(state.roundFile, self._envelope(room, state, 'round_ended', data, 'round'));
    state.roundOpen = false;
  });
};

HistoryStore.prototype.endRoom = function (room, data) {
  var self = this;
  this._safe(function () {
    var state = self._state(room); if (!state) return;
    if (state.roundOpen && state.roundFile) {
      self._append(state.roundFile, self._envelope(room, state, 'round_aborted', {
        reason: data && data.dissolved ? 'room_dissolved' : 'room_ended'
      }, 'round'));
      state.roundOpen = false;
    }
    self._append(state.roomFile, self._envelope(room, state, 'room_ended', data, 'room'));
  });
};

HistoryStore.prototype.getSessionPath = function (room) {
  var state = this.states.get(room);
  return state ? state.dir : null;
};

module.exports = {
  HistoryStore: HistoryStore,
  SCHEMA_VERSION: SCHEMA_VERSION,
  publicConfig: publicConfig,
  playerMeta: playerMeta
};
