/* 测试：客户端（jsdom）人机 UI 回归 —— 房间座位卡 / 牌桌标记 / 按钮请求体
 * 需要 jsdom（项目本身零依赖，所以未装时自动跳过）：
 *   NODE_PATH=C:/Users/Lenovo/.workbuddy/binaries/node/workspace/node_modules node test/ui-bot.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
// 真实房间那一段会把快照落盘，改到系统临时目录，别污染 server/data
process.env.ROOM_DATA_DIR = path.join(require('os').tmpdir(), 'ddz-test-rooms');
let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require('jsdom')); }
catch (e) { console.log('  - 跳过：未找到 jsdom（项目本身零依赖；装了 jsdom 再跑这个用例）'); process.exit(0); }

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(m, c, extra) {
  if (c) { pass++; console.log('  ✓ ' + m + (extra !== undefined ? '  (实际: ' + JSON.stringify(extra) + ')' : '')); }
  else { fail++; console.log('  ✗ ' + m + (extra !== undefined ? '  (实际: ' + JSON.stringify(extra) + ')' : '')); }
}

// ---------------- 搭 jsdom 环境 ----------------
const vc = new VirtualConsole();
const renderErrors = [];
vc.on('error', function () { renderErrors.push(Array.prototype.join.call(arguments, ' ')); });
vc.on('jsdomError', function (e) { renderErrors.push('jsdomError: ' + e.message); });

const dom = new JSDOM(HTML, {
  url: 'http://localhost:8080/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole: vc
});
const win = dom.window;

// 桩：网络 / SSE / 语音 / 音频
const fetchCalls = [];
win.fetch = function (url, opt) {
  var body = {};
  try { body = JSON.parse((opt && opt.body) || '{}'); } catch (e) {}
  fetchCalls.push({ url: url, body: body });
  return Promise.resolve({ json: function () { return Promise.resolve({ ok: true }); } });
};
let esInst = null;
win.EventSource = function (url) { this.url = url; esInst = this; this.close = function () {}; };
win.speechSynthesis = {
  speak: function () {}, cancel: function () {}, pause: function () {}, resume: function () {},
  getVoices: function () { return []; }, addEventListener: function () {}, removeEventListener: function () {}
};
win.SpeechSynthesisUtterance = function (t) { this.text = String(t || ''); };
win.AudioContext = undefined; win.webkitAudioContext = undefined;

// 让 app.js 启动时走「自动重连」分支 → 直接进房并建立 SSE
win.localStorage.setItem('ddz', JSON.stringify({ nick: '我', roomNo: '123456', password: '' }));

['public/js/rules.js', 'public/js/cards.js', 'public/js/audio.js', 'public/js/app.js'].forEach(function (rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  try { win.eval(code); } catch (e) { console.log('  ! 加载 ' + rel + ' 抛错：' + e.message); }
});

const doc = win.document;
function $(id) { return doc.getElementById(id); }
function txt(el) { return (el && el.textContent) || ''; }
function cards() { return Array.prototype.slice.call($('seatList').children); }
function pushState(st) { esInst.onmessage({ data: JSON.stringify(st) }); }

function P(seat, nick, isHost, isBot, ready) {
  return {
    seat: seat, nick: nick, isHost: !!isHost, isBot: !!isBot, isLandlord: false,
    ready: ready === undefined ? true : ready, connected: true, cardCount: 0,
    score: '0', stats: null, exited: false, isBot0: undefined, hand: null,
    bid: null, mult: null, reveal: null
  };
}
function baseState(players, extra) {
  const st = {
    type: 'state', roomNo: '123456', name: '测试房',
    config: { baseScore: 1, totalRounds: 5, playTimeout: 15, allowReveal: true, allowDouble: true, allowNegative: false, hasPassword: false },
    phase: 'waiting', round: 0, totalRounds: 5, hostSeat: 0, paused: false, pausedBy: null,
    players: players, you: '我', bottom: null, currentTurnSeat: null, deadline: null,
    multiplier: 1, interactions: [], passes: []
  };
  for (const k in (extra || {})) st[k] = extra[k];
  return st;
}

(async function main() {
  ok('app.js 已接管（进入了房间页）', !$('room').classList.contains('hidden'), esInst && esInst.url);

  // ============ 1. 房主视角：空位可加人机、人机位可移除 ============
  console.log('— 房主视角：座位卡上的人机按钮 —');
  pushState(baseState([P(0, '我', true, false), P(1, '小智', false, true), null, P(3, 'bob', false, false)]));
  const cs = cards();
  ok('座位卡渲染 4 个', cs.length === 4, cs.length);
  ok('人机座位带 bot 类', cs[1].classList.contains('bot') === true);
  ok('人机座位显示「🤖 机器人」角色标', txt(cs[1]).indexOf('🤖 机器人') >= 0, txt(cs[1]));
  ok('人机座位有「移除人机」按钮', txt(cs[1]).indexOf('移除人机') >= 0);
  ok('空座位有「＋ 添加人机」按钮', txt(cs[2]).indexOf('添加人机') >= 0 && txt(cs[2]).indexOf('空座位') >= 0, txt(cs[2]));
  ok('真人座位（房主）没有加/移人机按钮', txt(cs[0]).indexOf('添加人机') < 0 && txt(cs[0]).indexOf('移除人机') < 0, txt(cs[0]));
  ok('真人座位（bob）没有加/移人机按钮', txt(cs[3]).indexOf('添加人机') < 0 && txt(cs[3]).indexOf('移除人机') < 0, txt(cs[3]));
  ok('未满员提示里带「添加人机」引导', txt($('roomMsg')).indexOf('还差 1 人满员') >= 0 && txt($('roomMsg')).indexOf('添加人机') >= 0, txt($('roomMsg')));

  const startBtn = Array.prototype.slice.call($('roomActions').querySelectorAll('button'))
    .filter(function (b) { return txt(b).indexOf('开始游戏') >= 0; })[0];
  ok('人数不足时「开始游戏」禁用', !!startBtn && startBtn.disabled === true, startBtn && startBtn.disabled);

  // 点击：加人机 / 移除人机，检查请求体
  fetchCalls.length = 0;
  const addBtnEl = cs[2].querySelector('button');
  try { addBtnEl.click(); } catch (e) { ok('点击「＋ 添加人机」不抛错', false, e.message); }
  const remBtnEl = cs[1].querySelector('button');
  try { remBtnEl.click(); } catch (e) { ok('点击「移除人机」不抛错', false, e.message); }
  const addCall = fetchCalls.filter(function (c) { return c.url === '/api/bot' && c.body.action === 'add'; })[0];
  const remCall = fetchCalls.filter(function (c) { return c.url === '/api/bot' && c.body.action === 'remove'; })[0];
  ok('点「＋ 添加人机」发出 /api/bot action=add', !!addCall, addCall && addCall.body);
  ok('add 请求带正确座位号 2', !!addCall && addCall.body.seat === 2, addCall && addCall.body.seat);
  ok('add 请求带房主昵称与房间号', !!addCall && addCall.body.nick === '我' && addCall.body.roomNo === '123456', addCall && addCall.body);
  ok('点「移除人机」发出 /api/bot action=remove 座位 1', !!remCall && remCall.body.seat === 1, remCall && remCall.body);

  // ============ 2. 满员（1 真人 + 3 人机） ============
  console.log('— 满员：1 真人 + 3 人机 —');
  pushState(baseState([P(0, '我', true, false), P(1, '小智', false, true), P(2, '小美', false, true), P(3, '小强', false, true)]));
  const cs2 = cards();
  ok('3 个人机座位都带 bot 类', cs2.filter(function (c) { return c.classList.contains('bot'); }).length === 3);
  ok('满员提示写明有几个人机', txt($('roomMsg')).indexOf('已满员（其中 3 个人机）') >= 0, txt($('roomMsg')));
  const startBtn2 = Array.prototype.slice.call($('roomActions').querySelectorAll('button'))
    .filter(function (b) { return txt(b).indexOf('开始游戏') >= 0; })[0];
  ok('满员后「开始游戏」可用', !!startBtn2 && startBtn2.disabled === false);
  ok('房主操作区不出现「踢人机 / 转让人机」', txt($('roomActions')).indexOf('踢 小智') < 0 && txt($('roomActions')).indexOf('转让 小智') < 0, txt($('roomActions')));

  // ============ 3. 非房主视角：完全看不到人机管理入口 ============
  console.log('— 非房主视角：没有管理入口 —');
  pushState(baseState([P(0, '张三', true, false), P(1, '小智', false, true), null, P(3, '我', false, false)]));
  const cs3 = cards();
  ok('非房主看不到「添加人机」', cs3.every(function (c) { return txt(c).indexOf('添加人机') < 0; }), txt($('seatList')));
  ok('非房主看不到「移除人机」', cs3.every(function (c) { return txt(c).indexOf('移除人机') < 0; }));
  ok('非房主看不到开始/解散房间', txt($('roomActions')).indexOf('开始游戏') < 0 && txt($('roomActions')).indexOf('解散房间') < 0, txt($('roomActions')));
  ok('非房主的提示里没有「添加人机」引导', txt($('roomMsg')).indexOf('添加人机') < 0, txt($('roomMsg')));

  // ============ 4. 牌桌上的机器人标记（用真实房间状态） ============
  console.log('— 牌桌：机器人标记 —');
  const Room = require('../server/room.js').Room;
  const r = new Room({ name: '测试房', config: { totalRounds: 1, playTimeout: 5 } });
  r.broadcast = function () {};
  r.botThinkDelay = function () { return 1; };
  r.addPlayer('我', true);
  r.addBot(1); r.addBot(2); r.addBot(3);
  r.start();
  const gst = r.getState('我');
  ok('真实房间开局进入 bidding 阶段', gst.phase === 'bidding', gst.phase);
  pushState(gst);
  ok('牌桌渲染没抛错（无 console.error）', renderErrors.length === 0, renderErrors.slice(0, 2));
  const mkBots = doc.querySelectorAll('.mk.bot');
  ok('牌桌上 3 个人机都有「🤖 机器人」标记', mkBots.length === 3, mkBots.length);
  ok('机器人标记文案正确', txt(mkBots[0]).indexOf('机器人') >= 0, txt(mkBots[0]));
  ok('真人座位没有机器人标记', doc.querySelectorAll('.mk.bot').length === 3);

  // ============ 5. 全员人机也不崩（房主自己留着） ============
  console.log('— 边界：房主 + 3 人机开局后仍能正常渲染 —');
  pushState(r.getState('我'));
  ok('重复推送同一状态不抛错', renderErrors.length === 0, renderErrors.slice(0, 2));

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  try { r.stop && r.stop(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
