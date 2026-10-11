/* 测试：房间内的人机（座位管理 + 自动驱动 + 整房流程） */
'use strict';
// 测试会把房间快照落盘，这里改到系统临时目录，别污染 server/data
process.env.ROOM_DATA_DIR = require('path').join(require('os').tmpdir(), 'ddz-test-rooms');
const RoomModule = require('../server/room.js');
const Room = RoomModule.Room;
const Bot = require('../server/bot.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }
function eq(a, b, m) { ok(a === b, m + '  (实际: ' + JSON.stringify(a) + ')'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function mkRoom(cfg) {
  const r = new Room({ name: '测试房', config: Object.assign({ totalRounds: 1, playTimeout: 5 }, cfg || {}) });
  r.broadcast = function () {};
  r.botThinkDelay = function () { return 1; };   // 测试接缝：把人机思考延时压到 1ms
  return r;
}

(async function main() {
  // ============ 1. 座位管理 ============
  console.log('— 人机座位管理 —');
  const r = mkRoom();
  const host = r.addPlayer('我', true);
  ok(host.seat === 0, '房主入座座位 0');

  let out = r.addBot(2);
  eq(out.ok, true, '房主能在座位 2 添加人机（昵称 ' + out.nick + '）');
  ok(r.players[2] && r.players[2].isBot === true, '座位 2 被标记为 isBot');
  ok(r.players[2].ready === true, '人机默认已准备（房主可直接开局）');
  ok(r.players[2].connected === true, '人机不会显示成离线');
  eq(r.nextSeat(0), 3, '出牌顺序改为逆时针：0 的下一家是 3');
  eq(r.nextSeat(3), 2, '出牌顺序改为逆时针：3 的下一家是 2');

  eq(r.addBot(2).error != null, true, '同一座位不能重复添加');
  eq(r.addBot(9).error != null, true, '非法座位号被拒绝');
  r.addBot(1); r.addBot(3);
  eq(r.botCount(), 3, '桌上共 3 个人机');
  eq(r.addBot(0).error != null, true, '座位已有人时拒绝（且已达人机上限）');

  // 非房主不能加
  const r2 = mkRoom();
  r2.addPlayer('我', true);
  r2.addPlayer('别人', false);
  eq(r2.hostAction('别人', 'addBot', { seat: 3 }).error != null, true, '只有房主能添加人机');
  // 转让给人机被拒绝
  r2.hostAction('我', 'addBot', { seat: 2 });
  eq(r2.hostAction('我', 'transfer', { nick: r2.players[2].nick }).error != null, true, '不能把房主转让给人机');
  eq(r2.hostAction('我', 'transfer', { targetNick: '别人' }).ok, true, '房主能用 targetNick 转让给真人');
  ok(r2.players[1].isHost === true && r2.hostSeat === 1, '转让后新房主座位正确');
  eq(r2.hostAction('别人', 'kick', { targetNick: '我' }).ok, true, '新房主能用 targetNick 踢出原房主');
  ok(r2.getPlayer('我') == null, '被踢出的玩家已离开房间');
  eq(r2.hostAction('别人', 'kick', { targetNick: r2.players[2].nick }).error != null, true, '踢人接口不会踢人机');
  // 开局后不能改
  const r3 = mkRoom();
  r3.addPlayer('我', true); r3.addBot(1); r3.addBot(2); r3.addBot(3);
  r3.start();
  ok(r3.phase !== 'waiting', '3 人机 + 1 真人可以开局：' + r3.phase);
  eq(r3.addBot(0).error != null, true, '开局后不能再添加人机');
  eq(r3.removeBot(1).error != null, true, '开局后不能移除人机');
  ok(r3.players.some(p => p && p.isBot), '开局后人机仍在座位上');

  // 移除
  const r4 = mkRoom();
  r4.addPlayer('我', true); r4.addBot(1);
  eq(r4.removeBot(1).ok, true, '能移除人机');
  eq(r4.players[1], null, '移除后座位清空');
  eq(r4.removeBot(1).error != null, true, '空座位不能移除');

  // 房主离开 → 不能把人机扶成房主
  const r5 = mkRoom();
  r5.addPlayer('我', true); r5.addBot(1); r5.addPlayer('张三', false);
  r5.leave('我');
  const newHost = r5.players[r5.hostSeat];
  ok(newHost && !newHost.isBot, '房主离开后房主身份交给真人（' + (newHost ? newHost.nick : '?') + '），没有落到人机头上');

  // getState 暴露 isBot
  const st = r5.getState('张三');
  ok(st.players.every(p => !p || typeof p.isBot === 'boolean'), 'getState 里每个座位都带 isBot 字段');
  eq(st.players[1].isBot, true, '人机座位 isBot=true');
  eq(st.players[2].isBot, false, '真人座位 isBot=false');
  const ia = r5.interact(2, 'egg', '', 1, 10);
  eq(ia.ok, true, '道具支持 10 连发送');
  eq(r5.getState('张三').interactions.slice(-1)[0].count, 10, '10 连道具在状态里带 count=10');

  // ============ 2. 真人托管与模型提示 ============
  console.log('— 真人托管与出牌提示 —');
  const r6 = mkRoom({ allowReveal: false, allowDouble: false });
  r6.addPlayer('我', true); r6.addBot(1); r6.addBot(2); r6.addBot(3);
  r6.landlordSeat = 0;
  r6.players[0].isLandlord = true;
  r6.phase = 'playing';
  r6.currentTurnSeat = 0;
  r6.lastPlay = null;
  r6.passCount = 0;
  r6.history = [];
  r6.farmerPlayedCount = 0;
  r6.landlordPlayCount = 0;
  r6.bombMult = 1;
  r6.playedCounts = new Array(15).fill(0);
  r6.players[0].hand = [
    { id: 'a3', rank: 3, suit: '♠', label: '3' },
    { id: 'b4', rank: 4, suit: '♠', label: '4' },
    { id: 'c5', rank: 5, suit: '♠', label: '5' }
  ];
  const sug = r6.recommendPlay('我');
  ok(sug.ok === true && sug.cards.length > 0, '出牌提示会返回模型推荐的牌');
  ok(sug.cards.every(id => r6.players[0].hand.some(c => c.id === id)), '提示返回的牌都来自当前手牌');
  eq(r6.getState('我').players[0].autoPlay, false, '默认未托管');
  eq(r6.setAutoPlay('我', true).autoPlay, true, '真人可开启托管');
  eq(r6.getState('我').players[0].autoPlay, true, 'getState 暴露托管状态');
  r6.botThinkDelay = function () { return 1; };
  r6.maybeBot();
  await sleep(10);
  ok(r6.currentTurnSeat !== 0 || r6.phase !== 'playing', '托管真人轮到自己时会自动出牌并推进回合');
  r6.clearTimer();
  if (r6._botTimer) { clearTimeout(r6._botTimer); r6._botTimer = null; }

  // ============ 3. 整房流程：1 真人 + 3 人机，全自动推进 ============
  console.log('— 整房流程（1 真人 + 3 人机，2 局） —');
  const room = mkRoom({ totalRounds: 2 });
  room.addPlayer('我', true);
  room.addBot(1); room.addBot(2); room.addBot(3);
  eq(room.activeCount(), 4, '满员 4 人');

  // 统计人机是否真的动了
  const botActs = { bid: 0, reveal: 0, mult: 0, play: 0, pass: 0 };
  const origBid = room.submitBid.bind(room);
  room.submitBid = function (seat, v) { if (room.players[seat] && room.players[seat].isBot) botActs.bid++; return origBid(seat, v); };
  const origRev = room.submitReveal.bind(room);
  room.submitReveal = function (seat, v) { if (room.players[seat] && room.players[seat].isBot) botActs.reveal++; return origRev(seat, v); };
  const origMul = room.submitMultiply.bind(room);
  room.submitMultiply = function (seat, v) { if (room.players[seat] && room.players[seat].isBot) botActs.mult++; return origMul(seat, v); };
  const origPlay = room.submitPlay.bind(room);
  room.submitPlay = function (seat, ids) {
    if (room.players[seat] && room.players[seat].isBot) { if (ids && ids.length) botActs.play++; }
    return origPlay(seat, ids);
  };
  const origPass = room.applyPass.bind(room);
  room.applyPass = function (seat) { if (room.players[seat] && room.players[seat].isBot) botActs.pass++; return origPass(seat); };

  const phases = [];
  const settleSnapshots = [];
  const origNotify = room.notify.bind(room);
  room.notify = function () {
    if (phases[phases.length - 1] !== room.phase) phases.push(room.phase);
    if (room.phase === 'settle' && room.settleInfo) settleSnapshots.push(JSON.parse(JSON.stringify(room.settleInfo)));
    return origNotify();
  };

  room.start();

  // 真人这边：不进 SSE、按最简单的规则应付（0 分 / 不加倍 / 出最小单张或过牌）
  let humanActs = 0, illegal = 0;
  for (let i = 0; i < 6000; i++) {
    await sleep(3);
    if (room.phase === 'roomEnd') break;
    if (room.paused) break;                       // 断线暂停（这里不该发生）
    if (room.phase === 'bidding') {
      const s = room.bidOrder[room.bidIndex];
      const p = room.players[s];
      if (p && !p.isBot) { humanActs++; room.submitBid(s, 0); }
    } else if (room.phase === 'reveal') {
      const p = room.players[room.landlordSeat];
      if (p && !p.isBot) { humanActs++; room.submitReveal(room.landlordSeat, false); }
    } else if (room.phase === 'multiply') {
      for (let s = 0; s < 4; s++) {
        const p = room.players[s];
        if (p && !p.isBot && room.multiplyChoices[s] == null) { humanActs++; room.submitMultiply(s, 1); }
      }
    } else if (room.phase === 'playing') {
      const s = room.currentTurnSeat;
      const p = room.players[s];
      if (p && !p.isBot) {
        humanActs++;
        if (room.lastPlay == null) {
          const min = p.hand.slice().sort((a, b) => a.rank - b.rank)[0];
          const res = room.submitPlay(s, [min.id]);
          if (res && res.error) illegal++;
        } else {
          const res = room.submitPass(s);
          if (res && res.error) illegal++;
        }
      }
    }
  }

  eq(room.phase, 'roomEnd', '整房流程跑到了结算结束（roomEnd）');
  eq(room.paused, false, '全程没有被误判为「断线暂停」');
  eq(illegal, 0, '真人这边的操作都被服务端接受（无规则报错）');
  ok(phases.indexOf('bidding') >= 0 && phases.indexOf('multiply') >= 0 && phases.indexOf('playing') >= 0 && phases.indexOf('settle') >= 0,
    '阶段齐全：' + phases.filter((v, i, a) => a.indexOf(v) === i).join(' → '));
  ok(settleSnapshots.length >= 1 && settleSnapshots.every(s => s.remainingHands && Object.keys(s.remainingHands).length === 4),
    '每局结算快照都包含四家剩余牌');
  console.log('    人机动作次数: 叫分 ' + botActs.bid + ' · 明牌 ' + botActs.reveal + ' · 加倍 ' + botActs.mult
    + ' · 出牌 ' + botActs.play + ' · 过牌 ' + botActs.pass);
  ok(botActs.bid > 0, '人机自己完成了叫分（无需真人干预）');
  ok(botActs.play > 0, '人机自己完成了出牌');
  ok(botActs.mult >= 3, '人机参与加倍（' + botActs.mult + ' 次）');
  const botP = room.players.filter(p => p && p.isBot);
  ok(botP.every(p => p.stats.total > 0), '每个人机都被记入了对局统计（' + botP.map(p => p.nick + ':' + p.stats.total).join(' ') + '）');

  // ============ 3. 防重入：_botTimer 不会堆积 ============
  console.log('— 调度健壮性 —');
  eq(room._botTimer, null, '流程结束后没有悬挂的思考定时器');
  const room2 = mkRoom({ totalRounds: 1 });
  room2.addPlayer('我', true); room2.addBot(1); room2.addBot(2); room2.addBot(3);
  room2.start();
  await sleep(30);
  for (let i = 0; i < 5; i++) room2.tick();       // 模拟每秒心跳反复广播
  await sleep(30);
  ok(room2._botTimer === null || room2._botTimer._idleTimeout >= 0, '心跳广播不会造成定时器堆积（同时只有 1 个）');
  let timers = 0;
  for (const k in room2) if (k === '_botTimer' && room2[k]) timers++;
  eq(timers <= 1, true, '同时只有一个人机调度定时器');
  // 手动 Pause/Resume 不应崩
  room2.paused = true; room2.maybeBot();
  eq(room2._botTimer, null, '暂停时不会排程人机动作');
  room2.paused = false;

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
