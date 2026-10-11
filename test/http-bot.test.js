/* 测试：真实 HTTP 端到端 —— 进程内起服务端，走 /api/* 加人机，再用 SSE 看人机把一局打完
 * 只用 Node 内置能力（fetch / SSE 都是内建的），零依赖。
 * 端口固定 8199，避免占用正式服务的 8080。
 */
'use strict';
const fs = require('fs');
const path = require('path');

process.env.PORT = '8199';
process.env.ROOM_DATA_DIR = path.join(require('os').tmpdir(), 'ddz-test-rooms'); // 不污染 server/data
require('../server/index.js');        // require 即 listen

let pass = 0, fail = 0;
function ok(m, c, extra) {
  if (c) { pass++; console.log('  ✓ ' + m + (extra !== undefined ? '  (实际: ' + JSON.stringify(extra) + ')' : '')); }
  else { fail++; console.log('  ✗ ' + m + (extra !== undefined ? '  (实际: ' + JSON.stringify(extra) + ')' : '')); }
}
const BASE = 'http://127.0.0.1:8199';
function post(p, body) {
  return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function main() {
  await sleep(250); // 等 listen

  console.log('— 建房 + 人机增删（真实 HTTP）—');
  const cr = await post('/api/create', { nick: '我', name: '联调房', baseScore: 1, totalRounds: 1, playTimeout: 5, allowReveal: false, allowDouble: false });
  ok('/api/create 成功', cr.ok === true, cr.error || cr.roomNo);
  const roomNo = cr.roomNo;

  // 先让另一个真人进来占座（验证「只有房主能加/移除」时需要房里有个非房主）
  const jn = await post('/api/join', { roomNo, nick: '老王' });
  ok('老王成功入座', jn.ok === true, jn.error || jn.seat);

  let h = await post('/api/host', { roomNo, nick: '我', action: 'transfer', targetNick: '老王' });
  ok('房主能通过 HTTP 转让给真人', h.ok === true, h);
  h = await post('/api/host', { roomNo, nick: '老王', action: 'transfer', targetNick: '我' });
  ok('新房主能把房主转回来', h.ok === true, h);
  h = await post('/api/host', { roomNo, nick: '我', action: 'kick', targetNick: '老王' });
  ok('房主能通过 HTTP 踢出成员', h.ok === true, h);
  const jn2 = await post('/api/join', { roomNo, nick: '老王' });
  ok('被踢成员可重新加入等待房', jn2.ok === true, jn2.error || jn2.seat);

  let r = await post('/api/bot', { roomNo, nick: '我', action: 'add', seat: 2 });
  ok('/api/bot add seat=2 成功', r.ok === true, r);
  await post('/api/bot', { roomNo, nick: '我', action: 'add', seat: 3 });
  r = await post('/api/bot', { roomNo, nick: '我', action: 'add', seat: 2 });
  ok('同座位重复添加被拒', !!r.error, r);
  r = await post('/api/bot', { roomNo, nick: '我', action: 'add', seat: 7 });
  ok('非法座位被拒', !!r.error, r);
  r = await post('/api/bot', { roomNo, nick: '我', action: 'add', seat: 0 });
  ok('自己坐着的座位不能放人机', !!r.error, r);

  r = await post('/api/bot', { roomNo, nick: '老王', action: 'add', seat: 1 });
  ok('非房主不能添加人机（被明确拒绝）', !!r.error, r);
  r = await post('/api/bot', { roomNo, nick: '老王', action: 'remove', seat: 2 });
  ok('非房主不能移除人机', !!r.error, r);
  r = await post('/api/bot', { roomNo, nick: '路人甲', action: 'add', seat: 1 });
  ok('不在房间里的人不能添加人机', !!r.error, r);

  // 老王退房 → 房主给空出来的座位补第 3 个人机
  await post('/api/leave', { roomNo, nick: '老王' });
  r = await post('/api/bot', { roomNo, nick: '我', action: 'add', seat: 1 });
  ok('房主给空出来的座位补人机成功', r.ok === true, r);
  r = await post('/api/bot', { roomNo, nick: '我', action: 'add', seat: 1 });
  ok('已占座位不能再加人机', !!r.error, r);

  console.log('— SSE 观察人机自动把牌局打完 —');
  const ctrl = new AbortController();
  const res = await fetch(BASE + '/api/stream?room=' + roomNo + '&nick=' + encodeURIComponent('我'), { signal: ctrl.signal });
  ok('SSE 连接建立', res.ok === true, res.status);

  const phases = [];
  let botSeen = 0, msgCount = 0, lastState = null, sseErr = null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (function pump() {
    reader.read().then(({ value, done }) => {
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').filter(l => l.indexOf('data:') === 0)[0];
        if (!line) continue;
        let st; try { st = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
        msgCount++;
        lastState = st;
        if (phases[phases.length - 1] !== st.phase) phases.push(st.phase);
        const bots = (st.players || []).filter(p => p && p.isBot);
        botSeen = Math.max(botSeen, bots.length);
      }
      pump();
    }).catch(e => { sseErr = e.message; });
  })();

  r = await post('/api/start', { roomNo, nick: '我' });
  ok('/api/start 开局成功', !r.error, r);
  ok('开局后人机仍在座位上', await post('/api/bot', { roomNo, nick: '我', action: 'remove', seat: 1 }).then(x => !!x.error));
  r = await post('/api/autoplay', { roomNo, nick: '我', enabled: true });
  ok('/api/autoplay 能开启真人托管', r.ok === true && r.autoPlay === true, r);

  // 人机自己会叫分/出牌，真人只管过；等到结算或超时
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    if (lastState && lastState.phase === 'roomEnd') break;
    if (lastState && lastState.phase === 'playing' && lastState.currentTurnSeat === 0) {
      const sg = await post('/api/suggest', { roomNo, nick: '我' }).catch(e => ({ error: e.message }));
      ok('/api/suggest 轮到真人时给出推荐', sg.ok === true && (sg.pass || Array.isArray(sg.cards)), sg);
      await post('/api/autoplay', { roomNo, nick: '我', enabled: false }).catch(() => {});
      await post('/api/autoplay', { roomNo, nick: '我', enabled: true }).catch(() => {});
      break;
    }
    await sleep(120);
  }
  while (Date.now() - t0 < 180000) {
    if (lastState && lastState.phase === 'roomEnd') break;
    if (lastState && lastState.phase === 'playing' && lastState.currentTurnSeat === 0) {
      // 轮到我：先试出牌（非法会被拒），再直接过牌，避免卡住整局
      await post('/api/play', { roomNo, nick: '我', cards: [] }).catch(() => {});
      await post('/api/pass', { roomNo, nick: '我' }).catch(() => {});
    }
    await sleep(300);
  }
  ctrl.abort();

  ok('SSE 收到了状态推送', msgCount > 5, msgCount);
  ok('推送里能看到 3 个人机', botSeen === 3, botSeen);
  ok('推送里能看到真人托管状态', !!(lastState && lastState.players && lastState.players[0] && lastState.players[0].autoPlay), lastState && lastState.players && lastState.players[0]);
  ok('阶段推进到了结算结束 roomEnd', phases.indexOf('roomEnd') >= 0, phases.join(' → '));
  ok('人机自动完成了叫分阶段', phases.indexOf('bidding') >= 0, phases.join(' → '));
  ok('人机自动完成了出牌阶段', phases.indexOf('playing') >= 0);
  ok('全程没有被判为断线暂停', !(lastState && lastState.paused), lastState && lastState.paused);
  ok('SSE 读流没有报错', sseErr === null, sseErr);

  console.log('\n阶段轨迹：' + phases.join(' → '));
  console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');

  // 清掉这局测试落下的持久化快照，别污染 server/data
  try { fs.unlinkSync(path.join(__dirname, '..', 'server', 'data', 'room_' + roomNo + '.json')); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
