/*
 * index.js — 零依赖 HTTP + SSE 服务端
 * 提供：静态资源、SSE 实时推送、POST API（创建/加入/准备/叫分/明牌/加倍/出牌/过牌/离开/房主操作）。
 * 运行：node server/index.js  （设置 PORT 可改端口，默认 8080）
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var url = require('url');
var childProcess = require('child_process');

var RoomModule = require('./room.js');
var Room = RoomModule.Room;
var HistoryStore = require('./history-store.js').HistoryStore;

var PUBLIC_DIR = path.join(__dirname, '..', 'public');
var PORT = parseInt(process.env.PORT, 10) || 8080;

var rooms = {}; // roomNo -> Room
var historyStore = new HistoryStore();

// ---------------- 局域网地址 ----------------
// 房主多半是用 http://localhost:8080 打开页面的，但把 localhost 的链接发给好友
// 对方根本打不开。这里在服务端把真实的局域网 IP 一并下发给客户端，
// 客户端生成邀请链接时会自动换成这个地址。
function collectLanIps() {
  var manual = (process.env.PUBLIC_HOST || process.env.LAN_HOST || '').trim();
  if (manual) return [manual.replace(/^https?:\/\//, '').replace(/:\d+$/, '')];
  var ifaces = {};
  try {
    ifaces = os.networkInterfaces();
  } catch (e) {
    console.error('[server] 读取局域网网卡失败，邀请链接仅使用 localhost：', e && e.message);
    return [];
  }
  var all = [];
  function addIp(ip, name, source) {
    if (!ip) return;
    if (all.some(function (x) { return x.ip === ip; })) return;
    var p = ip.split('.').map(Number);
    if (p[0] === 169 && p[1] === 254) return;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return;
    all.push({ ip: ip, name: name || '', source: source || '' });
  }
  for (var name in ifaces) {
    (ifaces[name] || []).forEach(function (ni) {
      // 只取 IPv4、非回环；排除链路本地(169.254)与运营商级NAT/Tailscale(100.64/10)等不可用于局域网的地址
      if (ni.family !== 'IPv4' || ni.internal) return;
      addIp(ni.address, name, 'node');
    });
  }
  try {
    var ps = 'Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.IPAddress -notlike "100.*" } | ForEach-Object { "$($_.InterfaceAlias)|$($_.IPAddress)" }';
    var exe = process.platform === 'win32' ? 'powershell.exe' : 'powershell.exe';
    var out = childProcess.execFileSync(exe, ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 1500, windowsHide: true });
    out.split(/\r?\n/).forEach(function (line) {
      var m = line.trim().match(/^(.+)\|(\d+\.\d+\.\d+\.\d+)$/);
      if (m) addIp(m[2], m[1], 'powershell');
    });
  } catch (e) {}
  function isTypical(ip) {
    var p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    return false;
  }
  function isVirtualName(name) {
    return /wsl|hyper-v|vethernet|docker|virtualbox|vmware|loopback|npcap|tap|tailscale|zerotier/i.test(name || '');
  }
  function score(x) {
    var p = x.ip.split('.').map(Number), s = 0;
    if (p[0] === 192 && p[1] === 168) s += 80;
    else if (p[0] === 10) s += 70;
    else if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) s += 45;
    else if (isTypical(x.ip)) s += 30;
    if (/wi-?fi|wlan|ethernet|以太网|无线/i.test(x.name)) s += 20;
    if (x.source === 'powershell') s += 8;
    if (isVirtualName(x.name)) s -= 80;
    return s;
  }
  all.sort(function (a, b) { return score(b) - score(a); });
  return all.map(function (x) { return x.ip; });
}
var LAN_IPS = collectLanIps();
var PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
var LAN_URLS = PUBLIC_URL ? [PUBLIC_URL] : LAN_IPS.map(function (ip) { return 'http://' + ip + ':' + PORT; });

function broadcast(room) {
  for (var nick in room.clients) {
    if (!room.clients.hasOwnProperty(nick)) continue;
    var set = room.clients[nick];
    var state = room.getState(nick);
    // 带上局域网直连地址，供客户端生成邀请链接
    state.net = { ips: LAN_IPS, urls: LAN_URLS };
    var payload = 'data: ' + JSON.stringify(state) + '\n\n';
    set.forEach(function (res) { try { res.write(payload); } catch (e) {} });
  }
}

function removeRoom(roomNo) {
  var r = rooms[roomNo];
  if (r) { r.deleteData(); delete rooms[roomNo]; }
}

function getRoom(roomNo) { return rooms[roomNo]; }

// ---------------- 工具 ----------------
function sendJSON(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req, cb) {
  var data = '';
  req.on('data', function (c) { data += c; if (data.length > 1e6) req.destroy(); });
  req.on('end', function () { try { cb(null, data ? JSON.parse(data) : {}); } catch (e) { cb(e); } });
}

var MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  var rel = pathname === '/' ? '/index.html' : pathname;
  var filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (filePath.indexOf(PUBLIC_DIR) !== 0) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, function (err, content) {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------------- API ----------------
function handleApi(req, res, parsed, body) {
  var p = parsed.pathname;

  if (p === '/api/create' && req.method === 'POST') {
    // 客户端将配置平铺在请求体顶层
    var cfg = body.config || body;
    // 校验配置边界
    var config = {
      baseScore: Math.max(1, parseInt(cfg.baseScore, 10) || 1),
      totalRounds: Math.min(50, Math.max(1, parseInt(cfg.totalRounds, 10) || 5)),
      bidTimeout: Math.min(30, Math.max(5, parseInt(cfg.bidTimeout, 10) || 10)),
      choiceTimeout: Math.min(30, Math.max(5, parseInt(cfg.choiceTimeout, 10) || 10)),
      playTimeout: Math.min(60, Math.max(5, parseInt(cfg.playTimeout, 10) || 15)),
      dealMode: cfg.dealMode === 'random' ? 'random' : 'enhanced',
      password: (cfg.password || '').toString().slice(0, 20),
      allowReveal: cfg.allowReveal !== false,
      allowDouble: cfg.allowDouble !== false,
      allowNegative: cfg.allowNegative !== false
    };
    var room = new Room({ name: (body.name || '').toString().slice(0, 30) || '我的房间', config: config });
    room.broadcast = function () { broadcast(room); };
    room.cleanup = function () { removeRoom(room.roomNo); };
    var add = room.addPlayer(body.nick, true);
    if (add.error) { sendJSON(res, 400, add); return; }
    room.historyStore = historyStore;
    historyStore.startRoom(room);
    rooms[room.roomNo] = room;
    room.persist();
    sendJSON(res, 200, { ok: true, roomNo: room.roomNo, seat: add.seat, nick: body.nick });
    return;
  }

  if (p === '/api/join' && req.method === 'POST') {
    var room2 = getRoom(String(body.roomNo || ''));
    if (!room2) { sendJSON(res, 404, { error: '房间不存在' }); return; }
    if (room2.config.password && room2.config.password !== (body.password || '')) { sendJSON(res, 403, { error: '房间密码错误' }); return; }
    var add2 = room2.addPlayer(body.nick, false);
    if (add2.error) { sendJSON(res, 400, add2); return; }
    sendJSON(res, 200, { ok: true, roomNo: room2.roomNo, seat: add2.seat, nick: body.nick });
    return;
  }

  // 其余操作都需要房间号+昵称
  var need = ['/api/ready', '/api/start', '/api/bid', '/api/reveal', '/api/multiply', '/api/play', '/api/pass', '/api/leave', '/api/host', '/api/interact', '/api/bot', '/api/autoplay', '/api/suggest'];
  if (need.indexOf(p) >= 0 && req.method === 'POST') {
    var r3 = getRoom(String(body.roomNo || ''));
    if (!r3) { sendJSON(res, 404, { error: '房间不存在' }); return; }
    var pl = r3.getPlayer(body.nick);
    if (!pl) { sendJSON(res, 403, { error: '你不在该房间' }); return; }
    var seat = pl.seat;
    var out = { ok: true };
    if (p === '/api/ready') {
      pl.ready = !!body.ready;
      r3.recordRoomEvent('ready_changed', { seat: pl.seat, nick: pl.nick, ready: pl.ready });
      r3.broadcast();
    }
    else if (p === '/api/start') { out = r3.hostAction(body.nick, 'start'); }
    else if (p === '/api/bid') { r3.submitBid(seat, body.bid, 'human'); }
    else if (p === '/api/reveal') { r3.submitReveal(seat, body.reveal, 'human'); }
    else if (p === '/api/multiply') { r3.submitMultiply(seat, body.mult, 'human'); }
    else if (p === '/api/play') { out = r3.submitPlay(seat, body.cards || [], 'human'); }
    else if (p === '/api/pass') { out = r3.submitPass(seat, 'human'); }
    else if (p === '/api/autoplay') { out = r3.setAutoPlay(body.nick, !!body.enabled); }
    else if (p === '/api/suggest') { out = r3.recommendPlay(body.nick); }
    else if (p === '/api/leave') { out = r3.leave(body.nick); }
    else if (p === '/api/host') { out = r3.hostAction(body.nick, body.action, body); }
    else if (p === '/api/interact') { out = r3.interact(seat, body.kind, body.value, body.target, body.count); }
    else if (p === '/api/bot') {
      // 人机增删：仅房主、仅未开局（具体校验在 Room.addBot / removeBot 里）
      out = r3.hostAction(body.nick, body.action === 'remove' ? 'removeBot' : 'addBot', { seat: body.seat });
    }
    sendJSON(res, out.error ? 400 : 200, out);
    return;
  }

  sendJSON(res, 404, { error: 'unknown api' });
}

// ---------------- SSE 流 ----------------
function handleStream(req, res, parsed) {
  var q = parsed.query;
  var roomNo = String(q.room || '');
  var nick = String(q.nick || '');
  var room = getRoom(roomNo);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('retry: 3000\n\n');
  if (!room) {
    res.write('data: ' + JSON.stringify({ type: 'error', error: '房间不存在' }) + '\n\n');
    return;
  }
  room.addClient(nick, res);
  req.on('close', function () { room.removeClient(nick, res); });
}

// ---------------- 服务器 ----------------
var server = http.createServer(function (req, res) {
  var parsed = url.parse(req.url, true);
  var pathname = parsed.pathname;
  if (pathname.indexOf('/api/') === 0) {
    if (pathname === '/api/stream') { handleStream(req, res, parsed); return; }
    readBody(req, function (err, body) {
      if (err) { sendJSON(res, 400, { error: 'bad request' }); return; }
      handleApi(req, res, parsed, body || {});
    });
    return;
  }
  serveStatic(req, res, pathname);
});

// 每秒心跳：刷新倒计时
setInterval(function () {
  for (var k in rooms) { if (rooms.hasOwnProperty(k)) rooms[k].tick(); }
}, 1000);

server.listen(PORT, '0.0.0.0', function () {
  var suggest = LAN_IPS[0];
  console.log('=================================================');
  console.log('  欢乐四人斗地主（两副牌）服务端已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  if (suggest) console.log('  手机/平板访问: http://' + suggest + ':' + PORT + '  (同一 Wi-Fi/路由器下其他设备)');
  if (LAN_IPS.length > 1) console.log('  其他可用地址: ' + LAN_IPS.join(', '));
  else if (!suggest) console.log('  (未检测到局域网 IP，邀请链接将退回当前访问地址)');
  if (historyStore.enabled) console.log('  对局历史:   ' + historyStore.root);
  else console.log('  对局历史:   已关闭 (DDZ_HISTORY_ENABLED=0)');
  console.log('=================================================');
});
