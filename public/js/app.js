/* app.js — 斗地主客户端（原生 JS + SSE） */
(function () {
  'use strict';

  var Rules = window.DDZRules;
  var Cards = window.DDZCards;
  // 音效引擎（audio.js）；缺失时降级为空实现，保证游戏仍可玩
  var Snd = window.DDZAudio || {
    settings: { sfx: 0, bgm: 0, announce: false },
    unlock: function () {}, startBgm: function () {}, stopBgm: function () {},
    setSfx: function () {}, setBgm: function () {}, setAnnounce: function () {},
    sfx: function () {}, speak: function () {}, stopSay: function () {},
    preview: function () {}, loadVoices: function () {},
    voiceReport: function () { return null; },
    setVoiceSeed: function () {}, personaName: function () { return ''; },
    effectiveName: function () { return ''; }
  };

  var me = { nick: '', roomNo: '', password: '' };
  var sse = null;
  var lastState = null;
  var selected = {}; // cardId -> true
  var prevPlaySig = null; // 上一手的签名，用于检测“新一手”以触发特效
  var sceneReady = false; // 是否已完成首帧同步（首帧不补播已存在的上一手特效）
  var lastRoundNo = null; // 用于检测新一局（发牌音效）
  var seatEl = {};        // seat -> 座位 DOM（用于互动动画定位）
  var bubbles = {};       // seat -> { text, cls, until } 表情/快捷语气泡（跨重绘保持）
  var lastIaId = null;    // 已处理的互动 id（避免重复播放）
  var lastPassId = null;  // 已处理的过牌事件 id（避免重复播“不要”）
  var lastTagSig = '';    // 旧版出牌提示状态；离开房间时一并清理
  var pendingItem = null; // 正在选择目标的道具：egg / slipper / flower
  var pendingItemCount = 1;
  var pendingIcon = '';

  // ---------------- 工具 ----------------
  function $(id) { return document.getElementById(id); }
  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }
  var landscapeRequested = false;
  function setScreenMode(mode) {
    document.body.classList.toggle('mode-home', mode === 'home');
    document.body.classList.toggle('mode-room', mode === 'room');
    document.body.classList.toggle('mode-game', mode === 'game');
    if (mode === 'game') preferLandscape();
    else landscapeRequested = false;
    updateOrientationMode();
  }
  // 支持锁定方向的 Android/PWA 直接请求横屏；iOS 和普通浏览器通常不允许网页
  // 强制锁屏，失败时由 game-portrait-compat 的 CSS 旋转牌桌作为无感兜底。
  function preferLandscape() {
    if (landscapeRequested) return;
    var mobileLike = (navigator.maxTouchPoints || 0) > 0
      || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    if (!mobileLike) return;
    landscapeRequested = true;
    try {
      var orientation = window.screen && window.screen.orientation;
      if (orientation && typeof orientation.lock === 'function') {
        var request = orientation.lock('landscape');
        if (request && typeof request.catch === 'function') request.catch(function () {});
      }
    } catch (e) {}
  }
  function updateOrientationMode() {
    var isGame = document.body.classList.contains('mode-game');
    var isNarrowTouch = window.matchMedia && window.matchMedia('(pointer: coarse) and (max-width: 900px)').matches;
    var portrait = window.innerHeight > window.innerWidth;
    document.body.classList.toggle('game-portrait-compat', !!(isGame && isNarrowTouch && portrait));
  }
  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement
      || document.mozFullScreenElement || document.msFullscreenElement || null;
  }
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent || '')
      || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  }
  function isStandalone() {
    return navigator.standalone === true
      || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }
  function isDisplayModeFullscreen() {
    return !!(window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches);
  }
  function requestFullscreenFn(el) {
    return el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen
      || el.mozRequestFullScreen || el.msRequestFullscreen || null;
  }
  function exitFullscreenFn() {
    return document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen
      || document.mozCancelFullScreen || document.msExitFullscreen || null;
  }
  function showIOSFullscreenHelp() {
    var box = $('modalBox');
    box.className = 'modal-box ios-fullscreen-help';
    box.innerHTML = '<h2>在 iPhone / iPad 上全屏</h2>'
      + '<div class="ios-help-steps"><b>iOS 普通浏览器标签页不允许网页直接隐藏地址栏和工具栏。</b>'
      + '<ol><li>点击浏览器的“分享”按钮。</li><li>选择“添加到主屏幕”。</li><li>返回桌面，从新图标打开游戏。</li></ol>'
      + '<p>从主屏幕图标打开后会以横屏独立应用运行，不显示浏览器地址栏。</p></div>'
      + '<div class="close-row"><button id="iosFullscreenClose" class="primary">知道了</button></div>';
    show('modal');
    $('iosFullscreenClose').onclick = function () { hide('modal'); box.className = 'modal-box'; };
  }
  function enterFullscreen() {
    if (isStandalone()) { syncFullscreenUi(); return Promise.resolve(); }
    var root = document.documentElement;
    var fn = requestFullscreenFn(root);
    if (!fn) { if (isIOS()) showIOSFullscreenHelp(); else toast('当前浏览器不支持网页全屏'); return Promise.resolve(); }
    try {
      var p = fn.call(root);
      if (p && typeof p.then === 'function') {
        return p.then(function () {
          landscapeRequested = false;
          preferLandscape();
          syncFullscreenUi();
        }).catch(function () { if (isIOS()) showIOSFullscreenHelp(); else toast('浏览器拒绝了全屏请求'); });
      }
      landscapeRequested = false;
      preferLandscape();
      syncFullscreenUi();
      return Promise.resolve();
    } catch (e) { if (isIOS()) showIOSFullscreenHelp(); else toast('浏览器拒绝了全屏请求'); return Promise.resolve(); }
  }
  function toggleFullscreen() {
    if (fullscreenElement()) {
      var exitFn = exitFullscreenFn();
      if (exitFn) try { exitFn.call(document); } catch (e) {}
      return;
    }
    if (isStandalone()) {
      toast(isIOS() ? '当前已是 iOS 独立全屏模式' : '当前已是独立全屏模式');
      syncFullscreenUi();
      return;
    }
    // 某些 Android 浏览器会在普通标签页误报 display-mode: fullscreen。
    // 不能据此提前返回，仍应在本次用户点击中调用原生全屏接口。
    enterFullscreen();
  }
  function syncFullscreenUi() { document.body.classList.toggle('is-fullscreen', !!fullscreenElement() || isStandalone() || isDisplayModeFullscreen()); }
  document.addEventListener('fullscreenchange', syncFullscreenUi);
  document.addEventListener('webkitfullscreenchange', syncFullscreenUi);
  document.addEventListener('mozfullscreenchange', syncFullscreenUi);
  document.addEventListener('MSFullscreenChange', syncFullscreenUi);
  window.addEventListener('resize', updateOrientationMode);
  window.addEventListener('orientationchange', function () { setTimeout(updateOrientationMode, 80); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', updateOrientationMode);
  function fmtBig(str) {
    // 大数格式化：万/亿/兆/京
    try {
      var v = BigInt(str);
      var neg = v < 0; v = v < 0 ? -v : v;
      var s = v.toString();
      if (s.length <= 4) return (neg ? '-' : '') + s;
      var units = [[4, '万'], [8, '亿'], [12, '兆'], [16, '京']];
      for (var i = units.length - 1; i >= 0; i--) {
        if (s.length > units[i][0]) {
          var head = s.slice(0, s.length - units[i][0]);
          var tail = s.slice(s.length - units[i][0], s.length - units[i][0] + 4);
          var num = head + '.' + tail.replace(/0+$/, '');
          if (num.endsWith('.')) num = num.slice(0, -1);
          return (neg ? '-' : '') + num + units[i][1];
        }
      }
      return (neg ? '-' : '') + s;
    } catch (e) { return str; }
  }
  function api(path, data) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json(); });
  }
  // 轻提示（居中浮层，自动消失）
  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); toastTimer = null; }, ms || 2200);
  }
  // 复制到剪贴板（局域网 http 非安全上下文下 navigator.clipboard 不可用，需降级）
  function copyText(text) {
    function fallback() {
      var ta = null;
      try {
        ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0';
        document.body.appendChild(ta);
        ta.select(); ta.setSelectionRange(0, ta.value.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) { if (ta && ta.parentNode) ta.parentNode.removeChild(ta); return false; }
    }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      return navigator.clipboard.writeText(text)
        .then(function () { return true; }, function () { return fallback(); });
    }
    return Promise.resolve(fallback());
  }
  // 邀请信息：含可直接点开的加入链接（房间号 / 密码都带上）
  // 链接必须是「局域网直连地址」：房主常常是用 http://localhost:8080 打开的，
  // 把 localhost 链接发给好友，对方手机是打不开的 —— 所以服务端会把本机
  // 真实局域网 IP 随状态一起下发（state.net.urls），这里优先用它。
  function inviteBase() {
    var here = location.origin + location.pathname;
    var hn = (location.hostname || '').toLowerCase();
    var isLocal = hn === 'localhost' || hn === '127.0.0.1' || hn === '::1' || hn === '0.0.0.0' || hn === '';
    var net = lastState && lastState.net;
    if (isLocal && net && net.urls && net.urls.length) return net.urls[0] + location.pathname;
    return here;
  }
  function inviteMessage() {
    var name = (lastState && lastState.name) ? lastState.name : '欢乐四人斗地主';
    var url = inviteBase() + '?room=' + encodeURIComponent(me.roomNo)
      + (me.password ? '&pwd=' + encodeURIComponent(me.password) : '');
    return '【斗地主】来打牌！房间「' + name + '」房间号 ' + me.roomNo + '，点这个链接直接进 → ' + url;
  }
  function doInvite() {
    if (!me.roomNo) { toast('还没有进入房间'); return; }
    Snd.sfx('click');
    var msg = inviteMessage();
    copyText(msg).then(function (ok) {
      if (!ok) { toast('复制失败，手动复制下面这段：\n' + msg, 7000); return; }
      var hn = (location.hostname || '').toLowerCase();
      var local = hn === 'localhost' || hn === '127.0.0.1' || hn === '::1' || hn === '0.0.0.0';
      var net = lastState && lastState.net;
      if (local && !(net && net.urls && net.urls.length)) {
        toast('邀请信息已复制 📋\n但没检测到局域网地址，好友可能打不开链接', 4200);
      } else {
        toast('邀请信息已复制 📋\n发给好友，点链接即可直接进房', 2400);
      }
    });
  }
  // 大小王图案（不写汉字）：小丑帽 + 铃铛 + 脸；用 currentColor 继承红/黑以区分大小王
  function jokerSvg() {
    return '<svg class="joker-ico" viewBox="0 0 40 56" aria-hidden="true">'
      + '<path d="M5 19 L12 3 L18 15 L20 2 L22 15 L28 3 L35 19" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>'
      + '<circle cx="12" cy="3" r="2.9" fill="currentColor"/>'
      + '<circle cx="20" cy="1.8" r="2.9" fill="currentColor"/>'
      + '<circle cx="28" cy="3" r="2.9" fill="currentColor"/>'
      + '<path d="M5 19 Q20 25 35 19" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'
      + '<ellipse cx="20" cy="33" rx="10.5" ry="11.5" fill="none" stroke="currentColor" stroke-width="2.4"/>'
      + '<circle cx="15.5" cy="30" r="1.9" fill="currentColor"/>'
      + '<circle cx="24.5" cy="30" r="1.9" fill="currentColor"/>'
      + '<path d="M15 37.5 Q20 42 25 37.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'
      + '<path d="M9 47 Q20 53 31 47" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'
      + '</svg>';
  }
  function cardEl(card, opts) {
    opts = opts || {};
    var d = document.createElement('div');
    d.className = 'card ' + (card.color === 'red' ? 'red' : 'black')
      + (opts.mini ? ' mini' : '') + (opts.tiny ? ' tiny' : '') + (opts.back ? ' back' : '')
      + (opts.bomb ? ' bomb-mark' : '') + (opts.selectable ? ' selectable' : '') + (opts.selected ? ' selected' : '');
    if (opts.back) return d;
    if (card.isJoker) {
      // 大小王：图案呈现，无汉字；红=大王 / 黑=小王
      d.classList.add('joker');
      var ico = jokerSvg();
      d.innerHTML = '<span class="corner corner-joker">' + ico + '</span><span class="main main-joker">' + ico + '</span>';
    } else {
      // 左上角角标：即使多张牌互相重叠，每张牌的点数与花色也始终露在左上角，清晰可辨
      d.innerHTML = '<span class="corner"><span class="cr">' + card.label + '</span><span class="cs">' + card.suit + '</span></span>'
        + '<span class="main"><span class="suit">' + card.suit + '</span></span>';
    }
    if (opts.bomb) {
      var b = document.createElement('span'); b.className = 'bomb-badge'; b.textContent = '炸'; d.appendChild(b);
    }
    if (opts.selectable) {
      d.dataset.id = card.id;
    }
    return d;
  }
  function clearSelect() { selected = {}; }
  function syncSelectedCards() {
    var els = document.querySelectorAll('#hand .card.selectable');
    for (var i = 0; i < els.length; i++) {
      els[i].classList.toggle('selected', !!selected[els[i].dataset.id]);
    }
  }

  // ---------------- 明牌手牌（需要换行时两行平分牌数并居中） ----------------
  function revealedHandHtml(hand) {
    var sorted = hand.slice().sort(function (a, b) {
      if (a.rank !== b.rank) return b.rank - a.rank;
      return (a.suit || '').localeCompare(b.suit || '');
    });
    var rows = sorted.length > 17 ? 2 : 1; // 一行放不下就拆成两行
    var per = Math.ceil(sorted.length / rows);
    var html = '<div class="revealed-hand">';
    for (var i = 0; i < sorted.length; i += per) {
      html += '<div class="revealed-row">'
        + sorted.slice(i, i + per).map(function (c) { return cardEl(c, { tiny: true }).outerHTML; }).join('')
        + '</div>';
    }
    return html + '</div>';
  }

  // ---------------- 头顶气泡（表情 / 快捷语） ----------------
  // 座位会随状态刷新，气泡状态单独保存，刷新后自动补回；
  // 同一个气泡（same nonce）不重建 DOM，避免每次刷新都重播出场动画而闪烁。
  var bubbleNonce = 0;
  function renderBubble(seat) {
    var el = seatEl[seat];
    if (!el) return;
    var old = el.querySelector('.seat-bubble');
    var b = bubbles[seat];
    if (!b || b.until <= Date.now()) { delete bubbles[seat]; if (old) old.parentNode.removeChild(old); return; }
    if (old && old.dataset.nonce === String(b.nonce)) return;
    if (old) old.parentNode.removeChild(old);
    var d = document.createElement('div');
    d.className = 'seat-bubble ' + (b.cls || '');
    d.dataset.nonce = String(b.nonce);
    d.textContent = b.text;
    el.appendChild(d);
  }
  function showBubble(seat, text, cls, ms) {
    bubbles[seat] = { text: text, cls: cls || '', until: Date.now() + ms, nonce: ++bubbleNonce };
    renderBubble(seat);
    setTimeout(function () {
      if (bubbles[seat] && bubbles[seat].until <= Date.now()) { delete bubbles[seat]; renderBubble(seat); }
    }, ms + 60);
  }

  // ---------------- 牌型朗读文本 ----------------
  // 把牌面代号换成中文读法，中文语音引擎读起来更顺、不夹英文（A=尖 K=凯 Q=圈 J=勾）
  var SAY_LABEL = { 'A': '尖', 'K': '凯', 'Q': '圈', 'J': '勾', '10': '十' };
  function sayLabel(label) {
    var s = String(label == null ? '' : label);
    return SAY_LABEL[s.toUpperCase()] || s;
  }
  function playText(info, cards) {
    if (!info || !cards || !cards.length) return '';
    var sorted = cards.slice().sort(function (a, b) { return a.rank - b.rank; });
    var lo = sayLabel(sorted[0].label), hi = sayLabel(sorted[sorted.length - 1].label);
    function labelOfRank(r) {
      for (var i = 0; i < sorted.length; i++) if (sorted[i].rank === Number(r)) return sayLabel(sorted[i].label);
      return '';
    }
    switch (info.type) {
      case 'single': return '一张' + hi;
      case 'pair': return '对' + hi;
      case 'triple': return '仨' + hi;
      case 'triple_pair': {
        var cnt = {}, t = '', p2 = '';
        sorted.forEach(function (c) { cnt[c.rank] = (cnt[c.rank] || 0) + 1; });
        for (var k in cnt) {
          if (cnt.hasOwnProperty(k)) {
            if (cnt[k] === 3) t = labelOfRank(k);
            else if (cnt[k] === 2) p2 = labelOfRank(k);
          }
        }
        return '仨' + t + '带俩' + p2;
      }
      case 'straight': return '顺子 ' + lo + ' 到 ' + hi;
      case 'straight_pair': return '连对 ' + lo + ' 到 ' + hi;
      case 'airplane': return '飞机 ' + lo + ' 到 ' + hi;
      case 'airplane_pair': return '飞机带对 ' + lo + ' 到 ' + hi;
      case 'bomb': return info.count + '个' + hi + '，炸弹！';
      case 'rocket': return '火箭！';
      default: return Rules.typeName(info.type);
    }
  }

  // ---------------- 炸弹爆炸 / 火箭升天 ----------------
  function shakeScreen() {
    var g = document.querySelector('.table') || $('game'); if (!g) return;
    g.classList.add('fx-shake-screen');
    setTimeout(function () { g.classList.remove('fx-shake-screen'); }, 520);
  }
  function fxRemove(list, ms) {
    setTimeout(function () {
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].parentNode) list[i].parentNode.removeChild(list[i]);
    }, ms);
  }
  function fxBomb() {
    var layer = $('fxLayer'); if (!layer) return;
    var ball = document.createElement('div'); ball.className = 'fx-fireball'; layer.appendChild(ball);
    var s1 = document.createElement('div'); s1.className = 'fx-shock'; layer.appendChild(s1);
    var s2 = document.createElement('div'); s2.className = 'fx-shock d2'; layer.appendChild(s2);
    var colors = ['#ffb347', '#ff7a2f', '#ffd76a', '#9c5a2a', '#ffffff', '#ff5a1e'];
    var debris = [];
    for (var i = 0; i < 14; i++) {
      var d = document.createElement('div'); d.className = 'fx-debris';
      var ang = Math.random() * Math.PI * 2, dist = 90 + Math.random() * 260;
      d.style.setProperty('--dx', (Math.cos(ang) * dist).toFixed(1) + 'px');
      d.style.setProperty('--dy', (Math.sin(ang) * dist - 40).toFixed(1) + 'px');
      d.style.setProperty('--rot', Math.floor(Math.random() * 900 - 450) + 'deg');
      d.style.width = d.style.height = (6 + Math.random() * 8).toFixed(0) + 'px';
      d.style.background = colors[i % colors.length];
      layer.appendChild(d); debris.push(d);
    }
    fxRemove([ball, s1, s2].concat(debris), 1150);
    shakeScreen();
  }
  function fxRocket() {
    var layer = $('fxLayer'); if (!layer) return;
    var trail = document.createElement('div'); trail.className = 'fx-trail'; layer.appendChild(trail);
    var rk = document.createElement('div'); rk.className = 'fx-rocket'; rk.textContent = '🚀'; layer.appendChild(rk);
    setTimeout(function () {
      var fl = document.createElement('div'); fl.className = 'fx-flash'; layer.appendChild(fl);
      fxRemove([fl], 800);
    }, 880);
    fxRemove([trail, rk], 1350);
    shakeScreen();
  }
  // 炸弹/火箭：出牌者座位“冲击环” + 桌面这一手牌的一记弹跳
  // （单出炸弹时 lastPlay 只有炸弹本身，也照样触发）
  function bombSting(seat) {
    var host = seatEl[seat];
    if (host) {
      host.classList.remove('fx-blast');
      void host.offsetWidth;
      host.classList.add('fx-blast');
      setTimeout(function () { host.classList.remove('fx-blast'); }, 720);
    }
    var lp = host ? host.querySelector('.seat-play') : null;
    if (lp) {
      lp.classList.remove('fx-blast-cards');
      void lp.offsetWidth;
      lp.classList.add('fx-blast-cards');
      setTimeout(function () { lp.classList.remove('fx-blast-cards'); }, 720);
    }
  }
  // 出一手的签名：用来判断「是不是新的一手」
  function playSigOf(st) {
    if (!st.play || !st.play.lastPlay) return '';
    var s = (st.play.lastPlaySeat != null ? st.play.lastPlaySeat : -1);
    return s + ':' + st.play.lastPlay.cards.map(function (c) { return c.id; }).sort().join(',');
  }

  // ---------------- 局内互动（表情 / 道具 / 快捷指令） ----------------
  // 道具表：tone=attack 表示“攻击类”（命中炸裂），good 表示“赠予类”（命中温馨）；
  // say = 使用时按口音人设朗读的台词（会念出昵称，如“老王送你一朵小花”）
  var ITEMS = [
    { kind: 'egg', icon: '🥚', label: '扔鸡蛋', hit: '💥', tone: 'attack', verb: '把鸡蛋扔给 TA', say: '请你吃个鸡蛋' },
    { kind: 'tomato', icon: '🍅', label: '扔番茄', hit: '💥', tone: 'attack', verb: '把番茄扔给 TA', say: '送你一个番茄' },
    { kind: 'cabbage', icon: '🥬', label: '扔白菜', hit: '💥', tone: 'attack', verb: '把白菜扔给 TA', say: '送你一棵白菜' },
    { kind: 'slipper', icon: '🩴', label: '扔拖鞋', hit: '💥', tone: 'attack', verb: '把拖鞋扔给 TA', say: '送你一只拖鞋' },
    { kind: 'poop', icon: '💩', label: '扔大便', hit: '💥', tone: 'attack', verb: '把大便扔给 TA', say: '送你一坨大便' },
    { kind: 'ice', icon: '🧊', label: '砸冰块', hit: '❄️', tone: 'attack', verb: '把冰块砸向 TA', say: '给你降降温' },
    { kind: 'water', icon: '🪣', label: '泼冷水', hit: '💧', tone: 'attack', verb: '给 TA 泼一桶冷水', say: '给你泼盆冷水' },
    { kind: 'firecracker', icon: '🧨', label: '放鞭炮', hit: '🎆', tone: 'attack', verb: '在 TA 面前放串鞭炮', say: '给你放串鞭炮' },
    { kind: 'flower', icon: '🌹', label: '送花', hit: '💗', tone: 'good', verb: '送花给 TA', say: '送你一朵小花' },
    { kind: 'gift', icon: '🎁', label: '送礼物', hit: '🎉', tone: 'good', verb: '送 TA 一份礼物', say: '送你一份礼物' },
    { kind: 'beer', icon: '🍺', label: '敬杯酒', hit: '🍻', tone: 'good', verb: '敬 TA 一杯', say: '敬你一杯酒' },
    { kind: 'kiss', icon: '💋', label: '么么哒', hit: '💕', tone: 'good', verb: '对 TA 么么哒', say: '送你一个么么哒' },
    { kind: 'diamond', icon: '💎', label: '送钻石', hit: '✨', tone: 'good', verb: '送 TA 一颗钻石', say: '送你一颗大钻石' },
    { kind: 'crown', icon: '👑', label: '送皇冠', hit: '👑', tone: 'good', verb: '给 TA 戴上皇冠', say: '给你戴上皇冠' }
  ];
  // 被砸 / 被送东西之后，接收者的一句“反应”（按互动 id 取，各端看到的是同一句）；
  // 台词同时出现在头顶气泡里，并用人设口音念出来。
  var REACT_ATTACK = ['哎哟，谁打我', '过分了啊', '我记住你了', '别打了别打了', '谁扔的这是'];
  var REACT_GOOD = ['谢谢老板', '嘿嘿，真香', '你人真好', '爱你哟', '谢谢谢谢'];
  var ITEM_ICON = {}, ITEM_HIT = {}, ITEM_MAP = {};
  ITEMS.forEach(function (it) { ITEM_ICON[it.kind] = it.icon; ITEM_HIT[it.kind] = it.hit; ITEM_MAP[it.kind] = it; });

  // 表情：分组展示，内容更丰富
  var EMOJI_GROUPS = [
    { title: '表情', list: ['😀', '😄', '😁', '😂', '🤣', '😊', '😍', '🥰', '😘', '😜', '🤪', '😎', '🤩', '🥳', '😏', '😒', '🙄', '🤔', '🤫', '😴', '🥱', '😤', '😡', '🤬', '🤯', '😱', '😨', '🥺', '😭', '😅'] },
    { title: '手势', list: ['👍', '👎', '👏', '🙌', '🙏', '💪', '✌️', '🤝', '👌', '🤙', '🫡', '🖖', '🤟', '☝️', '👊', '🫰'] },
    { title: '搞怪', list: ['🤡', '👻', '💀', '👽', '🤖', '💩', '🐔', '🐷', '🐒', '🦆', '🐢', '🐸', '🍺', '🍻', '🥂', '🔥', '💣', '⚡', '🎉', '🎊', '🧧', '🀄', '🎲', '🚀', '🌈', '❤️', '💔', '⭐', '😈', '🤠'] }
  ];

  // 快捷指令：分组展示，say 为朗读文本（避免语音把数字/符号读错）
  var CHAT_GROUPS = [
    {
      title: '礼貌', list: [
        { text: '666', say: '六六六' },
        { text: '你的牌打得也太好了', say: '你的牌打得也太好了' },
        { text: '打得漂亮', say: '打得漂亮' },
        { text: '承让承让', say: '承让承让' },
        { text: '好牌不常有，且行且珍惜', say: '好牌不常有，且行且珍惜' },
        { text: '稳，太稳了', say: '稳，太稳了' }
      ]
    },
    {
      title: '吐槽', list: [
        { text: '速度速度', say: '速度速度' },
        { text: '别急，我在思考人生', say: '别急，我在思考人生' },
        { text: '这也太背了吧', say: '这也太背了吧' },
        { text: '我怀疑有人开挂', say: '我怀疑有人开挂' },
        { text: '这波不亏', say: '这波不亏' },
        { text: '又输了，人已麻', say: '又输了，人已麻' }
      ]
    },
    {
      title: '玩梗', list: [
        { text: '得得得得得得得得得得', say: '得得得得得得' },
        { text: '就这？', say: '就这' },
        { text: '你礼貌吗', say: '你礼貌吗' },
        { text: '早知道不叫地主了', say: '早知道不叫地主了' },
        { text: '我要开始表演了', say: '我要开始表演了' },
        { text: '恭喜发财，红包拿来', say: '恭喜发财，红包拿来' }
      ]
    },
    {
      title: '嚣张', list: [
        { text: '不要走，决战到天亮', say: '不要走，决战到天亮' },
        { text: '大家注意，我要放大招了', say: '大家注意，我要放大招了' },
        { text: '不好意思，我又赢了', say: '不好意思，我又赢了' },
        { text: '明牌怎么了，我乐意', say: '明牌怎么了，我乐意' },
        { text: '菜就多练', say: '菜就多练' },
        { text: '春天警告', say: '春天警告' }
      ]
    }
  ];
  // 自定义快捷指令：存在本地，随时可加/删
  var CUSTOM_KEY = 'ddz_chat_custom';
  var customChats = [];
  try {
    var _cc = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
    if (Object.prototype.toString.call(_cc) === '[object Array]') {
      customChats = _cc.filter(function (t) { return typeof t === 'string' && t.trim(); }).slice(0, 12);
    }
  } catch (e) { customChats = []; }
  function saveCustomChats() { try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(customChats)); } catch (e) {} }

  function chatSay(text) {
    for (var i = 0; i < CHAT_GROUPS.length; i++) {
      var l = CHAT_GROUPS[i].list;
      for (var j = 0; j < l.length; j++) if (l[j].text === text) return l[j].say;
    }
    return text;
  }
  function visibleAvatarForSeat(seat) {
    var host = seatEl[seat];
    var avatar = host ? host.querySelector('.avatar') : null;
    var mySeat = lastState ? seatOf(lastState, me.nick) : null;
    // 移动端自己的原座位框被隐藏，改用牌桌底边信息栏中的可见头像。
    if (seat === mySeat) {
      var mobileAvatar = $('mobileSelfBar') ? $('mobileSelfBar').querySelector('.avatar') : null;
      if (mobileAvatar) {
        var mobileRect = mobileAvatar.getBoundingClientRect();
        if (mobileRect.width > 0 && mobileRect.height > 0) return mobileAvatar;
      }
    }
    if (avatar) {
      var rect = avatar.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return avatar;
    }
    return host;
  }

  // 道具飞行：统一从发送者头像飞向目标头像，命中后播动画、音效与「接收者反应」。
  function flyItem(kind, fromSeat, toSeat, iaId, doReact) {
    var a = seatEl[fromSeat], b = seatEl[toSeat];
    if (!a || !b) return;
    var fromAvatar = visibleAvatarForSeat(fromSeat);
    var toAvatar = visibleAvatarForSeat(toSeat);
    if (!fromAvatar || !toAvatar) return;
    var ra = fromAvatar.getBoundingClientRect(), rb = toAvatar.getBoundingClientRect();
    var x0 = ra.left + ra.width / 2, y0 = ra.top + ra.height / 2;
    var x1 = rb.left + rb.width / 2, y1 = rb.top + rb.height / 2;
    Snd.sfx('whoosh');
    var el = document.createElement('div');
    el.className = 'fx-fly';
    el.textContent = ITEM_ICON[kind] || '❓';
    el.style.left = x0 + 'px';
    el.style.top = y0 + 'px';
    document.body.appendChild(el);
    var spin = kind === 'slipper' ? 900 : (kind === 'egg' ? 540 : 0);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.style.transform = 'translate(-50%, -50%) translate(' + (x1 - x0).toFixed(1) + 'px,' + (y1 - y0).toFixed(1) + 'px) rotate(' + spin + 'deg)';
      });
    });
    var landed = false;
    function land() {
      if (landed) return;
      landed = true;
      if (el.parentNode) el.parentNode.removeChild(el);
      var sp = document.createElement('div');
      sp.className = 'fx-splat';
      sp.textContent = ITEM_HIT[kind] || '💥';
      sp.style.left = x1 + 'px';
      sp.style.top = y1 + 'px';
      document.body.appendChild(sp);
      fxRemove([sp], 820);
      if (b) { b.classList.add('hit'); setTimeout(function () { b.classList.remove('hit'); }, 540); }
      Snd.sfx(kind);
      if (doReact !== false) reactToItem(kind, toSeat, iaId);
    }
    el.addEventListener('transitionend', function (ev) { if (ev.propertyName === 'transform') land(); });
    setTimeout(land, 900);
  }
  // 接收者的反应：头顶气泡 + 用他自己的口音念一句（按互动 id 选，各端一致）
  function reactToItem(kind, toSeat, iaId) {
    var it = ITEM_MAP[kind];
    var list = (it && it.tone === 'good') ? REACT_GOOD : REACT_ATTACK;
    var react = list[Math.abs(Number(iaId) || 0) % list.length];
    showBubble(toSeat, react, 'react', 3000);
    var p = lastState ? lastState.players[toSeat] : null;
    Snd.speak(react, toSeat, 2, p ? p.nick : '');
  }
  function handleInteractions(st) {
    if (!st.interactions) return;
    if (lastIaId === null) {
      // 首次进入 / 重连：只记录基线，不重放历史消息
      lastIaId = st.interactions.length ? st.interactions[st.interactions.length - 1].id : 0;
      return;
    }
    for (var i = 0; i < st.interactions.length; i++) {
      var it = st.interactions[i];
      if (it.id <= lastIaId) continue;
      lastIaId = it.id;
      applyInteraction(it);
    }
  }
  function applyInteraction(it) {
    if (it.kind === 'emoji') { showBubble(it.seat, it.value, 'emoji', 2600); Snd.sfx('emoji'); return; }
    if (it.kind === 'chat') {
      showBubble(it.seat, it.value, '', 3800);
      Snd.sfx('chat');
      Snd.speak(chatSay(it.value), it.seat, 2, it.nick); // 按座位口音朗读；优先级 2：互动最优先
      return;
    }
    var item = ITEM_MAP[it.kind];
    if (item && item.say) Snd.speak(item.say, it.seat, 2, it.nick); // 使用者台词，如“老王送你一朵小花”
    var n = it.count === 10 ? 10 : 1;
    for (var k = 0; k < n; k++) {
      (function (idx) {
        setTimeout(function () { flyItem(it.kind, it.seat, it.target, it.id + idx, idx === 0); }, idx * 95);
      })(k);
    }
  }
  // PC 与移动端统一把“不要”放到该玩家原本显示出牌的位置。
  function showPassAtPlayPosition(seat, ms) {
    var mySeat = lastState ? seatOf(lastState, me.nick) : null;
    var host;
    var marker = document.createElement('div');
    marker.textContent = '不要';
    if (seat === mySeat) {
      host = document.querySelector('#game .table');
      marker.className = 'self-pass-play';
    } else {
      host = seatEl[seat];
      marker.className = 'seat-pass-play';
    }
    if (!host) return;
    var old = host.querySelector(seat === mySeat ? ':scope > .self-pass-play' : ':scope > .seat-pass-play');
    if (old) old.remove();
    host.appendChild(marker);
    setTimeout(function () { if (marker.parentNode) marker.parentNode.removeChild(marker); }, ms);
  }

  // 过牌播报：谁过了牌就说一句“不要”。
  function handlePasses(st) {
    if (!st.passes) return;
    if (lastPassId === null) {
      lastPassId = st.passes.length ? st.passes[st.passes.length - 1].id : 0;
      return;
    }
    for (var i = 0; i < st.passes.length; i++) {
      var pe = st.passes[i];
      if (pe.id <= lastPassId) continue;
      lastPassId = pe.id;
      showPassAtPlayPosition(pe.seat, 1700);
      Snd.speak('不要', pe.seat, 0, pe.nick);
    }
  }
  function sendInteract(kind, value, target, count) {
    Snd.sfx('click');
    api('/api/interact', { roomNo: me.roomNo, nick: me.nick, kind: kind, value: value, target: target == null ? null : target, count: count || 1 })
      .then(function (r) { if (r && r.error) flash(r.error); });
  }

  // ---------------- 互动面板、声音设置与房主设置 ----------------
  // 三个入口各自一个面板：emojiPanel / itemPanel / chatPanel，互斥展开
  var IA_PANELS = ['emojiPanel', 'itemPanel', 'chatPanel'];
  var IA_BTN_OF = { emojiPanel: 'btnEmoji', itemPanel: 'btnItem', chatPanel: 'btnChat' };
  function closeInteract() {
    IA_PANELS.forEach(function (id) {
      var p = $(id); if (p) p.classList.add('hidden');
      var b = $(IA_BTN_OF[id]); if (b) b.classList.remove('active');
    });
  }
  function openInteract(id) {
    closeAudio();
    closeRoomSettings();
    var wasHidden = $(id).classList.contains('hidden');
    closeInteract();
    if (wasHidden) { $(id).classList.remove('hidden'); $(IA_BTN_OF[id]).classList.add('active'); }
  }
  function openAudio() { closeInteract(); closeRoomSettings(); syncAudioUI(); renderVoiceDiag(); $('audioPanel').classList.remove('hidden'); }
  function closeAudio() { $('audioPanel').classList.add('hidden'); }
  function closeRoomSettings() { $('roomSettingsPanel').classList.add('hidden'); }
  var roomSettingsSig = '';
  function renderRoomSettings(st) {
    if (!st) return;
    var sig = [st.config.bidTimeout, st.config.choiceTimeout, st.config.playTimeout, st.config.dealMode]
      .concat(st.players.map(function (p) { return p ? [p.nick, p.isHost, p.isBot, p.muted].join(':') : '-'; })).join('|');
    if (sig === roomSettingsSig) return;
    roomSettingsSig = sig;
    $('hsBidTimeout').value = st.config.bidTimeout || 10;
    $('hsChoiceTimeout').value = st.config.choiceTimeout || 10;
    $('hsPlayTimeout').value = st.config.playTimeout || 15;
    $('hsDealMode').value = st.config.dealMode === 'random' ? 'random' : 'enhanced';
    var box = $('hsPlayers'); box.innerHTML = '';
    st.players.forEach(function (p) {
      if (!p || p.isHost || p.isBot) return;
      var row = document.createElement('div'); row.className = 'settings-player';
      var name = document.createElement('span'); name.className = 'settings-player-name';
      name.textContent = p.nick + (p.muted ? '（已禁言）' : ''); row.appendChild(name);
      addBtn(row, p.muted ? '解除禁言' : '禁言', p.muted ? 'ghost' : 'warn', function () {
        api('/api/host', { roomNo: me.roomNo, nick: me.nick, action: 'mute', targetNick: p.nick, muted: !p.muted })
          .then(function (r) { if (r && r.error) flash(r.error); });
      });
      addBtn(row, '转交房主', 'ghost', function () {
        if (!confirm('确定把房主转交给“' + p.nick + '”？')) return;
        api('/api/host', { roomNo: me.roomNo, nick: me.nick, action: 'transfer', targetNick: p.nick })
          .then(function (r) { if (r && r.error) flash(r.error); else closeRoomSettings(); });
      });
      box.appendChild(row);
    });
    if (!box.childNodes.length) box.innerHTML = '<div class="settings-note">当前没有可管理的真人玩家。</div>';
  }
  function updateRoomSettingsAccess(st) {
    var seat = seatOf(st, me.nick);
    var host = seat != null && st.players[seat] && st.players[seat].isHost;
    ['btnRoomSettings', 'btnRoomSettings2'].forEach(function (id) {
      var b = $(id); if (b) b.classList.toggle('hidden', !host);
    });
    if (!host) closeRoomSettings();
    else if (!$('roomSettingsPanel').classList.contains('hidden')) renderRoomSettings(st);
  }
  function toggleRoomSettings() {
    if (!lastState) return;
    var panel = $('roomSettingsPanel');
    if (!panel.classList.contains('hidden')) { closeRoomSettings(); return; }
    closeInteract(); closeAudio(); roomSettingsSig = ''; renderRoomSettings(lastState); panel.classList.remove('hidden');
  }
  function syncAudioUI() {
    var s = Snd.settings || {};
    $('volSfx').value = String(Math.round((s.sfx || 0) * 100));
    $('volSfxVal').textContent = $('volSfx').value;
    $('volBgm').value = String(Math.round((s.bgm || 0) * 100));
    $('volBgmVal').textContent = $('volBgm').value;
    $('chkAnnounce').checked = s.announce !== false;
  }
  // 发声自检：把「本机有哪些音色、每个座位实际会用哪种口音」显示出来。
  // 手机上「没声音」十有八九是系统没装中文语音数据，这里能一眼看出来。
  function renderVoiceDiag() {
    var box = $('voiceDiag');
    if (!box) return;
    var r = null;
    try { r = Snd.voiceReport ? Snd.voiceReport() : null; } catch (e) { r = null; }
    if (!r) {
      box.innerHTML = '<div class="dg-line dg-bad">这个浏览器不支持语音朗读</div>';
      return;
    }
    var html = '<div class="dg-line">本机可用音色 <b>' + r.count + '</b> 个 · 中文音色 '
      + '<b class="' + (r.hasChinese ? 'dg-ok' : 'dg-bad') + '">' + (r.hasChinese ? '已安装' : '未检测到') + '</b></div>';
    if (!r.hasChinese) {
      html += '<div class="dg-warn">没有中文音色时，中文播报会念成乱码（已自动跳过）。'
        + '手机请在「系统设置 → 语言与输入 → 文字转语音」里安装中文语音数据（普通话 / 粤语）。</div>';
    }
    var players = (lastState && lastState.players) || [];
    var mySeat = lastState ? seatOf(lastState, me.nick) : null;
    r.seats.forEach(function (s) {
      var who = players[s.seat] ? players[s.seat].nick : ('座位 ' + (s.seat + 1));
      if (s.seat === mySeat) who += '（我）';
      html += '<div class="dg-seat">' + esc(who) + '：<b>' + esc(s.effective) + '</b>'
        + (s.changed ? '<span class="dg-na">← 本机没有「' + esc(s.assigned) + '」音色，改用这个</span>'
          : (s.mimic ? '<span class="dg-na">（本机没有专用音色，用普通话音色模仿）</span>' : '')) + '</div>';
    });
    if (!r.hasChinese && r.count && !r.personas.some(function (p) { return p.real; })) {
      html += '<div class="dg-line dg-bad">未找到任何中文音色</div>';
    }
    box.innerHTML = html;
  }
  function startTargetPick(kind, count) {
    var it = ITEM_MAP[kind];
    pendingItem = kind; pendingItemCount = count === 10 ? 10 : 1; pendingIcon = it ? it.icon : '';
    closeInteract();
    $('targetHint').textContent = '点击目标玩家头像：' + (it ? it.verb : '对 TA 使用道具') + (pendingItemCount === 10 ? ' ×10' : '');
    $('targetBar').classList.remove('hidden');
    Snd.sfx('click');
    if (lastState) render(lastState); // 高亮可点选的座位
  }
  function cancelTargetPick() {
    pendingItem = null; pendingItemCount = 1; pendingIcon = '';
    $('targetBar').classList.add('hidden');
    if (lastState) render(lastState);
  }
  // 生成一个小分组（标题 + 内容容器），返回内容容器
  function makeGroup(parent, title) {
    var wrap = document.createElement('div'); wrap.className = 'ip-group';
    var t = document.createElement('div'); t.className = 'ip-group-title'; t.textContent = title;
    wrap.appendChild(t);
    var box = document.createElement('div');
    wrap.appendChild(box);
    parent.appendChild(wrap);
    return box;
  }
  function renderEmojiPanel() {
    var ebox = $('ipEmoji'); if (!ebox || ebox.dataset.built) return;
    ebox.dataset.built = '1';
    EMOJI_GROUPS.forEach(function (g) {
      var box = makeGroup(ebox, g.title); box.className = 'emoji-grid';
      g.list.forEach(function (em) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = em; b.title = '发这个表情';
        b.onclick = function () { sendInteract('emoji', em, null); };
        box.appendChild(b);
      });
    });
  }
  function renderItemPanel() {
    var ibox = $('ipItems'); if (!ibox || ibox.dataset.built) return;
    ibox.dataset.built = '1';
    [['attack', '搞事情'], ['good', '送温暖']].forEach(function (grp) {
      var box = makeGroup(ibox, grp[1]); box.className = 'item-grid';
      ITEMS.filter(function (it) { return it.tone === grp[0]; }).forEach(function (it) {
        var wrap = document.createElement('span'); wrap.className = 'item-choice ' + it.tone;
        var b = document.createElement('button'); b.type = 'button';
        b.className = it.tone + ' item-once';
        b.setAttribute('data-kind', it.kind);
        b.innerHTML = '<span class="it-ico">' + it.icon + '</span>' + esc(it.label);
        b.onclick = function () { startTargetPick(it.kind, 1); };
        var ten = document.createElement('button'); ten.type = 'button';
        ten.className = it.tone + ' item-ten';
        ten.textContent = '×10';
        ten.title = it.label + ' 10 连';
        ten.onclick = function () { startTargetPick(it.kind, 10); };
        wrap.appendChild(b); wrap.appendChild(ten);
        box.appendChild(wrap);
      });
    });
  }
  function renderChatPanel() {
    var cbox = $('ipChat'); if (!cbox) return;
    cbox.innerHTML = '';
    CHAT_GROUPS.forEach(function (g) {
      var box = makeGroup(cbox, g.title); box.className = 'chat-list';
      g.list.forEach(function (c) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = c.text;
        b.onclick = function () { sendInteract('chat', c.text, null); closeInteract(); };
        box.appendChild(b);
      });
    });
    if (customChats.length) {
      var box2 = makeGroup(cbox, '我加的');
      box2.className = 'chat-list';
      customChats.forEach(function (txt, idx) {
        var item = document.createElement('span'); item.className = 'chat-item';
        var b = document.createElement('button'); b.type = 'button'; b.className = 'mine'; b.textContent = txt;
        b.onclick = function () { sendInteract('chat', txt, null); closeInteract(); };
        var del = document.createElement('button'); del.type = 'button'; del.className = 'chat-del';
        del.textContent = '✕'; del.title = '删除这句';
        del.onclick = function (ev) {
          ev.stopPropagation();
          customChats.splice(idx, 1); saveCustomChats(); renderChatPanel();
        };
        item.appendChild(b); item.appendChild(del); box2.appendChild(item);
      });
    }
  }
  (function bindInteractUI() {
    renderEmojiPanel(); renderItemPanel(); renderChatPanel();

    // 三个入口按钮：各开各的面板，再点一次收起
    $('btnEmoji').onclick = function () { openInteract('emojiPanel'); };
    $('btnItem').onclick = function () { openInteract('itemPanel'); };
    $('btnChat').onclick = function () { openInteract('chatPanel'); };
    $('btnAudio').onclick = function () {
      var panel = $('audioPanel');
      if (panel.classList.contains('hidden')) openAudio(); else closeAudio();
    };
    $('ipCloseEmoji').onclick = closeInteract;
    $('ipCloseItem').onclick = closeInteract;
    $('ipCloseChat').onclick = closeInteract;
    $('apClose').onclick = closeAudio;
    $('rspClose').onclick = closeRoomSettings;
    $('btnRoomSettings').onclick = toggleRoomSettings;
    $('btnRoomSettings2').onclick = toggleRoomSettings;
    $('btnSaveRoomSettings').onclick = function () {
      api('/api/host', {
        roomNo: me.roomNo, nick: me.nick, action: 'settings',
        config: {
          bidTimeout: $('hsBidTimeout').value,
          choiceTimeout: $('hsChoiceTimeout').value,
          playTimeout: $('hsPlayTimeout').value,
          dealMode: $('hsDealMode').value
        }
      }).then(function (r) {
        if (r && r.error) { flash(r.error); return; }
        toast('房间设置已保存'); closeRoomSettings();
      });
    };

    // 自定义快捷指令：回车或点“添加”保存
    function addCustomChat() {
      var inp = $('chatCustomInput');
      var v = (inp.value || '').trim();
      if (!v) return;
      if (customChats.indexOf(v) < 0) {
        customChats.push(v);
        if (customChats.length > 12) customChats = customChats.slice(-12);
        saveCustomChats();
      }
      inp.value = '';
      renderChatPanel();
      toast('已添加自定义快捷语');
    }
    $('chatCustomAdd').onclick = addCustomChat;
    $('chatCustomInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addCustomChat(); }
    });
    $('targetCancel').onclick = cancelTargetPick;
    $('btnInvite').onclick = doInvite;
    $('btnInvite2').onclick = doInvite;
    $('btnRules').onclick = showRules;
    $('btnFullscreen').onclick = toggleFullscreen;
    $('volSfx').oninput = function () { Snd.setSfx(this.value / 100); $('volSfxVal').textContent = String(this.value); };
    $('volBgm').oninput = function () { Snd.setBgm(this.value / 100); $('volBgmVal').textContent = String(this.value); };
    $('chkAnnounce').onchange = function () { Snd.setAnnounce(this.checked); };
    // 试听：按当前音量与座位口音念一句，方便在手机上确认到底有没有声音
    $('btnTestVoice').onclick = function () {
      if (Snd.loadVoices) Snd.loadVoices();
      Snd.unlock();
      Snd.sfx('deal');
      var s = mySeatNo();
      Snd.preview('试听，对二，炸弹，不要', s == null ? 0 : s);
      renderVoiceDiag();
    };
    $('btnRefreshVoice').onclick = function () {
      if (Snd.loadVoices) Snd.loadVoices();
      Snd.stopSay(true);
      renderVoiceDiag();
      toast('已重新检测本机音色');
    };
    // 点击座位选择互动目标（座位会被重绘，故用事件委托）
    var table = document.querySelector('.table');
    if (table) {
      table.addEventListener('click', function (e) {
        if (!pendingItem) return;
        var node = e.target;
        while (node && node !== document.body && !(node.classList && node.classList.contains('seat'))) node = node.parentNode;
        if (!node || node === document.body || !node.dataset) return;
        var seat = Number(node.dataset.seat);
        if (isNaN(seat)) return;
        var mySeat = lastState ? seatOf(lastState, me.nick) : null;
        if (seat === mySeat) return;
        var kind = pendingItem;
        var count = pendingItemCount;
        cancelTargetPick();
        sendInteract(kind, count, seat, count);
      });
    }
    syncAudioUI();
  })();
  // 首次用户手势解锁音频（浏览器自动播放策略）
  function unlockAudio() {
    Snd.unlock();
    document.removeEventListener('pointerdown', unlockAudio);
    document.removeEventListener('touchstart', unlockAudio);
    document.removeEventListener('keydown', unlockAudio);
  }
  document.addEventListener('pointerdown', unlockAudio);
  document.addEventListener('touchstart', unlockAudio);
  document.addEventListener('keydown', unlockAudio);

  // ---------------- 选牌（鼠标 + 触摸，按几何位置判定） ----------------
  // 不再依赖 DOM 命中测试：按「每张牌露出的部分」计算点击落在哪一张上，
  // 因此即使手牌互相遮挡、或已选中的牌上抬露出下面的牌，也不会误选成别的牌。
  var dragMode = null;     // true=选中, false=取消
  var startCard = null, startX = 0, startY = 0, dragMoved = false;
  var lastTouchTs = 0;     // 抑制触摸后浏览器补发的合成鼠标事件（否则会重复切换）
  var DRAG_SLOP = 8;       // 区分「点选」与「拖动」的阈值

  function evPoint(e) {
    if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (e.changedTouches && e.changedTouches.length) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }
  // 命中判定：落在某张牌「未被遮挡的露出部分」内即算这张牌
  function cardAtPoint(x, y) {
    var hand = $('hand');
    if (!hand || !hand.children.length) return null;
    var kids = hand.children;
    // 从视觉上层往下找。transform 后的真实牌面位置由 getBoundingClientRect 给出，
    // 因此选中的牌上抬后，点击它露出的上半截会命中它自己，而不是下面/旁边的牌。
    for (var i = kids.length - 1; i >= 0; i--) {
      var el = kids[i];
      var r = el.getBoundingClientRect();
      if (x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 3 && y <= r.bottom + 3) return el;
    }
    return null;
  }
  function paintCard(el) {
    if (!el || dragMode === null) return;
    var id = el.dataset.id;
    if (!id) return;
    if (dragMode === true) selected[id] = true; else delete selected[id];
    el.classList.toggle('selected', !!selected[id]);
  }
  function handDown(e) {
    if (e.type === 'mousedown') {
      if (e.button !== 0) return;
      if (Date.now() - lastTouchTs < 900) return; // 触摸后的合成鼠标事件，忽略
    } else {
      lastTouchTs = Date.now();
    }
    var pt = evPoint(e);
    var t = cardAtPoint(pt.x, pt.y);
    if (!t) return;
    if (e.type === 'mousedown' && e.cancelable) e.preventDefault(); // 防止鼠标拖拽选中文字
    startCard = t;
    startX = pt.x; startY = pt.y; dragMoved = false;
    dragMode = !selected[t.dataset.id]; // 起始牌未选中 → 进入“选中”模式，反之“取消”
  }
  function handMove(e) {
    if (!startCard) return;
    var pt = evPoint(e);
    if (!dragMoved) {
      if (Math.abs(pt.x - startX) < DRAG_SLOP && Math.abs(pt.y - startY) < DRAG_SLOP) return;
      dragMoved = true;
      if (e.cancelable) e.preventDefault(); // 进入拖拽：阻止页面滚动
      paintCard(startCard);                 // 起始牌着色
    } else if (e.cancelable && e.type === 'touchmove') {
      e.preventDefault();
    }
    var c = cardAtPoint(pt.x, pt.y);
    if (c) paintCard(c);
  }
  function handUp() {
    if (startCard && !dragMoved) paintCard(startCard); // 未移动 = 单击切换
    startCard = null; dragMode = null; dragMoved = false;
  }
  (function bindHandDrag() {
    var h = $('hand');
    h.addEventListener('mousedown', handDown);
    document.addEventListener('mousemove', handMove);
    document.addEventListener('mouseup', handUp);
    h.addEventListener('touchstart', handDown, { passive: false });
    document.addEventListener('touchmove', handMove, { passive: false });
    document.addEventListener('touchend', handUp);
    document.addEventListener('touchcancel', handUp);
  })();

  // ---------------- 首页 ----------------
  $('btnShowCreate').onclick = function () { hide('joinPanel'); show('createPanel'); };
  $('btnShowJoin').onclick = function () { hide('createPanel'); show('joinPanel'); };
  $('btnBack1').onclick = function () { hide('createPanel'); };
  $('btnBack2').onclick = function () { hide('joinPanel'); };
  $('btnCreate').onclick = function () {
    enterFullscreen();
    var nick = $('nick').value.trim();
    if (!nick) { $('homeMsg').textContent = '请先输入房间昵称'; return; }
    me.nick = nick;
    api('/api/create', {
      nick: nick, name: $('cr_name').value.trim(), baseScore: $('cr_base').value,
      totalRounds: $('cr_rounds').value, playTimeout: $('cr_timeout').value,
      password: $('cr_pwd').value, allowReveal: $('cr_reveal').checked, allowDouble: $('cr_double').checked
    }).then(function (r) {
      if (r.error) { $('homeMsg').textContent = r.error; return; }
      me.roomNo = r.roomNo; me.password = $('cr_pwd').value;
      localStorage.setItem('ddz', JSON.stringify(me));
      enterRoom();
    });
  };
  $('btnJoin').onclick = function () {
    enterFullscreen();
    var nick = $('nick').value.trim();
    if (!nick) { $('homeMsg').textContent = '请先输入房间昵称'; return; }
    me.nick = nick;
    me.roomNo = $('jn_room').value.trim();
    me.password = $('jn_pwd').value;
    api('/api/join', { nick: nick, roomNo: me.roomNo, password: me.password }).then(function (r) {
      if (r.error) { $('homeMsg').textContent = r.error; return; }
      localStorage.setItem('ddz', JSON.stringify(me));
      enterRoom();
    });
  };

  function enterRoom() {
    hide('home'); hide('game'); show('room');
    if (Snd.setVoiceSeed) Snd.setVoiceSeed(me.roomNo); // 房间号做种子：同房间各端口音分配一致
    Snd.startBgm(); // 进入房间开始背景音乐（音量可在互动面板调节）
    connectStream();
  }
  function goHome() {
    if (sse) { sse.close(); sse = null; }
    localStorage.removeItem('ddz');
    hide('room'); hide('game'); hide('modal');
    show('home');
    setScreenMode('home');
    $('homeMsg').textContent = '';
    // 清理房间相关的临时状态
    lastIaId = null; bubbles = {}; seatEl = {}; lastRoundNo = null;
    prevPlaySig = null; sceneReady = false; pendingItem = null; clearSelect();
    prevBidSig = null; prevRevealSig = null; prevMultSig = null; lastTagSig = '';
    lastPassId = null;
    $('targetBar').classList.add('hidden');
    closeInteract();
    closeAudio();
    Snd.stopSay(true); // 只丢弃还没播的，正在播的那句让它说完
  }

  // ---------------- SSE ----------------
  function connectStream() {
    if (sse) sse.close();
    sse = new EventSource('/api/stream?room=' + encodeURIComponent(me.roomNo) + '&nick=' + encodeURIComponent(me.nick));
    sse.onmessage = function (ev) {
      try {
        var st = JSON.parse(ev.data);
        if (st.type === 'error') { $('homeMsg').textContent = st.error; goHome(); return; }
        lastState = st;
        render(st);
      } catch (e) {
        if (window.console && console.error) console.error('[ddz] 渲染状态失败：', e);
      }
    };
    sse.onerror = function () {
      // 房间可能已解散
    };
  }

  // ---------------- 渲染总入口 ----------------
  function render(st) {
    if (st.phase === 'waiting') { hide('game'); show('room'); setScreenMode('room'); renderRoom(st); }
    else { hide('room'); show('game'); setScreenMode('game'); renderGame(st); }
    // 结算/最终榜 由 renderGame 管理；此处仅处理暂停遮罩
    if (st.paused && st.phase !== 'roomEnd') showPause(st);
    else hidePause();
  }

  // ---------------- 房间等待 ----------------
  function renderRoom(st) {
    updateRoomSettingsAccess(st);
    $('roomTitle').textContent = st.name + '（房间号 ' + st.roomNo + '）';
    $('roomCfg').textContent = '底分 ' + st.config.baseScore + ' · 总局数 ' + st.config.totalRounds + ' · 出牌 ' + st.config.playTimeout + 's'
      + ' · ' + (st.config.dealMode === 'random' ? '完全随机' : '炸弹增强')
      + (st.config.hasPassword ? ' · 有密码' : '') + (st.config.allowReveal ? ' · 明牌' : '') + (st.config.allowDouble ? ' · 加倍' : '');
    var list = $('seatList'); list.innerHTML = '';
    var mySeat = seatOf(st, me.nick);
    var imHost = (mySeat != null) && st.players[mySeat] && st.players[mySeat].isHost;
    // 每个座位：空位可由房主放人机，人机位可由房主移走
    function addBotControls(card, seat) {
      if (!imHost) return;
      var row = document.createElement('div'); row.className = 'bot-row';
      var p = st.players[seat];
      if (!p) {
        addBtn(row, '＋ 添加人机', 'bot-mini', function () {
          api('/api/bot', { roomNo: me.roomNo, nick: me.nick, action: 'add', seat: seat }).then(function (r) {
            if (r && r.error) flash(r.error);
          });
        });
      } else if (p.isBot) {
        addBtn(row, '移除人机', 'bot-mini ghost', function () {
          api('/api/bot', { roomNo: me.roomNo, nick: me.nick, action: 'remove', seat: seat }).then(function (r) {
            if (r && r.error) flash(r.error);
          });
        });
      }
      if (row.childNodes.length) card.appendChild(row);
    }
    for (var i = 0; i < 4; i++) {
      var p = st.players[i];
      var card = document.createElement('div');
      card.className = 'seat-card' + (p && p.isHost ? ' host' : '') + (p && p.isLandlord ? ' landlord' : '') + (p && p.isBot ? ' bot' : '');
      if (!p) {
        card.innerHTML = '<div class="nm" style="color:#9bb">空座位</div><div class="meta">等待玩家加入…</div>';
        addBotControls(card, i);
        list.appendChild(card); continue;
      }
      card.innerHTML = '<div><span class="nm">' + esc(p.nick) + '</span>'
        + (p.isHost ? '<span class="role">房主</span>' : '')
        + (p.isBot ? '<span class="role bot-tag">🤖 机器人</span>' : '') + '</div>'
        + '<div class="meta">积分 ' + fmtBig(p.score) + '</div>'
        + '<span class="tag ' + (p.connected ? 'ready' : 'off') + '">' + (p.connected ? '在线' : '离线') + '</span>'
        + (p.ready ? '<span class="tag ready">已准备</span>' : '');
      addBotControls(card, i);
      list.appendChild(card);
    }
    // 操作区
    var act = $('roomActions'); act.innerHTML = '';
    if (mySeat == null) { act.innerHTML = '<span class="msg">你不在该房间（可能房间已重置）</span>'; return; }
    var count = st.players.filter(function (x) { return x; }).length;
    var botN = st.players.filter(function (x) { return x && x.isBot; }).length;
    if (!st.players[mySeat].ready) addBtn(act, '准备', 'primary', function () { api('/api/ready', { roomNo: me.roomNo, nick: me.nick, ready: true }); });
    else addBtn(act, '取消准备', '', function () { api('/api/ready', { roomNo: me.roomNo, nick: me.nick, ready: false }); });
    if (imHost) {
      // 人数不足（还没凑满 4 人）时直接禁用，少一次白点
      addBtn(act, '开始游戏', 'primary', function () { api('/api/start', { roomNo: me.roomNo, nick: me.nick }); }, count < 4);
      addBtn(act, '解散房间', '', function () { if (confirm('确定解散房间？')) api('/api/host', { roomNo: me.roomNo, nick: me.nick, action: 'dissolve' }); });
      // 踢人仍保留在等待区；禁言和转让统一收进右上角“房间设置”。
      for (var j = 0; j < 4; j++) {
        var q = st.players[j];
        if (q && !q.isHost && !q.isBot) {
          addBtn(act, '踢 ' + q.nick, '', function (nm) {
            if (confirm('踢出 ' + nm + '？')) {
              api('/api/host', { roomNo: me.roomNo, nick: me.nick, action: 'kick', targetNick: nm }).then(function (r) {
                if (r && r.error) flash(r.error);
              });
            }
          }.bind(null, q.nick));
        }
      }
    }
    addBtn(act, '排行榜', 'ghost', function () { showLeaderboard(st); });
    $('roomMsg').textContent = count < 4
      ? '还差 ' + (4 - count) + ' 人满员' + (imHost ? '，也可以直接点空座位的「＋ 添加人机」补位' : '')
      : (botN ? '已满员（其中 ' + botN + ' 个人机）' : '已满员，房主可以开始游戏');
  }

  // ---------------- 牌桌 ----------------
  // 倒计时：渲染时就写入正确秒数（不再先显示占位符再被刷新，避免一闪一闪）
  function clockRemain(deadline) { return Math.max(0, Number(deadline || 0) - Date.now()); }
  function clockHtml(st) {
    if (!st.deadline) return '';
    var remain = clockRemain(st.deadline);
    return '<div class="clock' + (remain <= 5000 ? ' low' : '') + '" data-dl="' + st.deadline + '" data-dur="' + timerDuration(st) + '">'
      + '<span class="clock-num">' + Math.ceil(remain / 1000) + '</span></div>';
  }
  function syncClockNum(numEl, deadline) {
    var txt = String(Math.ceil(clockRemain(deadline) / 1000));
    if (numEl.textContent !== txt) numEl.textContent = txt;
    var c = numEl.parentNode;
    var low = clockRemain(deadline) <= 5000;
    if (c && c.classList.contains('low') !== low) c.classList.toggle('low', low);
  }

  // 叫分 / 明牌 / 加倍：语音播报（带昵称，各玩家音色不同）
  var CN_NUM = ['零', '一', '两', '三'];
  var prevBidSig = null, prevRevealSig = null, prevMultSig = null;
  function announceChoices(st) {
    var i, p, a, b;
    var parts = function (arr) { return arr.join(','); };
    // 叫分：0=不叫，1/2/3=叫几分
    var bs = st.players.map(function (q) { return q ? (q.bid == null ? '-' : q.bid) : 'x'; });
    if (prevBidSig) {
      for (i = 0; i < 4; i++) {
        p = st.players[i];
        if (!p || bs[i] === 'x' || prevBidSig[i] === 'x') continue;
        if (prevBidSig[i] === '-' && bs[i] !== '-') {
          var v = Number(bs[i]);
          Snd.speak(v > 0 ? '叫' + (CN_NUM[v] || v) + '分' : '不叫', i, 1, p.nick);
        }
      }
    }
    prevBidSig = bs;
    // 明牌
    var rs = st.players.map(function (q) { return q ? (q.reveal === true ? '1' : '0') : 'x'; });
    if (prevRevealSig) {
      for (i = 0; i < 4; i++) {
        p = st.players[i];
        if (!p || rs[i] === 'x' || prevRevealSig[i] === 'x') continue;
        if (rs[i] === '1' && prevRevealSig[i] !== '1') Snd.speak('明牌', i, 1, p.nick);
      }
    }
    prevRevealSig = rs;
    // 加倍：1=不加倍，2=加倍，4=超级加倍
    var ms = st.players.map(function (q) { return q ? (q.mult == null ? '-' : q.mult) : 'x'; });
    if (prevMultSig) {
      for (i = 0; i < 4; i++) {
        p = st.players[i];
        if (!p || ms[i] === 'x' || prevMultSig[i] === 'x') continue;
        if (prevMultSig[i] === '-' && ms[i] !== '-') {
          var mv = Number(ms[i]);
          Snd.speak(mv === 4 ? '超级加倍' : (mv === 2 ? '加倍' : '不加倍'), i, 1, p.nick);
        }
      }
    }
    prevMultSig = ms;
  }

  function renderGame(st) {
    updateRoomSettingsAccess(st);
    $('roomInfo').innerHTML = '<b>' + esc(st.name) + '</b><i>房间号 ' + esc(st.roomNo) + '</i>';
    $('roundInfo').innerHTML = '<b>第 ' + st.round + ' / ' + st.totalRounds + ' 局</b><i>底分 ' + st.config.baseScore + ' · ' + st.config.playTimeout + 's</i>';
    // 新一局：发牌音效
    if (st.round !== lastRoundNo) {
      if (lastRoundNo !== null && st.phase !== 'roomEnd') Snd.sfx('deal');
      lastRoundNo = st.round;
    }
    var m = st.multiplier;
    $('multInfo').innerHTML = '<b>×' + fmtBig(String(m.total)) + '</b><i>叫' + m.C + ' 炸' + m.D + ' 明' + m.M + ' 双' + m.X + '</i>';
    announceChoices(st);

    var mySeat = seatOf(st, me.nick);
    var mine = st.players[mySeat];
    var muted = !!(mine && mine.muted);
    ['btnEmoji', 'btnItem', 'btnChat'].forEach(function (id) {
      var b = $(id); if (!b) return;
      b.disabled = muted;
      b.title = muted ? '你已被房主禁言' : (id === 'btnEmoji' ? '发表情' : (id === 'btnItem' ? '使用道具' : '发送快捷指令'));
    });
    if (muted) { closeInteract(); pendingItem = null; $('targetBar').classList.add('hidden'); }
    var autoBtn = $('btnAutoPlay');
    if (autoBtn) {
      var autoOn = !!(mine && mine.autoPlay);
      autoBtn.classList.toggle('active', autoOn);
      autoBtn.innerHTML = autoOn ? '🤖<span>取消托管</span>' : '🤖<span>托管</span>';
      autoBtn.title = autoOn ? '取消托管，恢复手动操作' : '开启托管，由 AI 自动操作';
      autoBtn.disabled = !mine || !!mine.isBot;
    }
    // 座位定位：bottom=自己，right=下一家(-1), top=对家, left=上一家(+1)；服务端按逆时针出牌
    var pos = { bottom: mySeat, left: (mySeat + 1) % 4, top: (mySeat + 2) % 4, right: (mySeat + 3) % 4 };
    // 各阶段“正在操作”的座位：叫分/出牌为单人，明牌为地主，加倍为所有未选者
    function seatActing(seat, p) {
      if (!p) return false;
      if (st.phase === 'bidding') return !!(st.bid && st.bid.currentSeat === seat);
      if (st.phase === 'reveal') return !!(st.reveal && st.reveal.landlordSeat === seat);
      if (st.phase === 'multiply') return p.mult == null;
      if (st.phase === 'playing') return st.currentTurnSeat === seat;
      return false;
    }
    ['top', 'left', 'right', 'bottom'].forEach(function (pp) {
      var seat = pos[pp];
      var p = st.players[seat];
      var el = document.querySelector('.seat-' + pp);
      var isTurn = seatActing(seat, p);
      el.className = 'seat seat-' + pp
        + (isTurn ? ' turn' : '')
        + (p ? (p.isLandlord ? ' landlord' : ' farmer') : '')
        + (p && !p.connected ? ' offline' : '')
        + (p && p.nick === me.nick ? ' self' : '')
        + (pendingItem && p && p.nick !== me.nick ? ' targetable' : '');
      el.dataset.seat = String(seat);
      seatEl[seat] = el;
      if (!p) {
        var emptySig = 'empty';
        if (el.dataset.sig !== emptySig) { el.dataset.sig = emptySig; el.innerHTML = '<div class="seat-empty">空座位</div>'; }
        return;
      }
      var role = p.isLandlord ? '地主' : (st.phase === 'waiting' ? '' : '农民');
      // 本局公开状态：叫分 / 加倍 / 明牌
      // 固定属性放到右上角；底部只保留真正生效的局内状态，避免标签堆满一行。
      var fixedMarks = '';
      var actionMarks = '';
      if (p.isBot) fixedMarks += '<span class="mk bot">🤖 机器人</span>';
      if (p.autoPlay && !p.isBot) fixedMarks += '<span class="mk autoplay">🤖 托管</span>';
      if (p.muted) fixedMarks += '<span class="mk muted">🔇 已禁言</span>';
      if (p.mult > 1) actionMarks += '<span class="mk mult">' + (p.mult === 4 ? '超级加倍 ×4' : '加倍 ×2') + '</span>';
      if (p.reveal === true) actionMarks += '<span class="mk reveal">明牌 ×2</span>';
      // 该玩家的语音口音（房间号随机分配：普通话音 / 东北话 / 四川话 / 广东话 / 台湾腔 / English）
      // 需要真音色的口音（粤语/台湾/英文）若本机没装对应语音包，会改用本机说得出来的
      // 口音，这里如实显示成「广东话→普通话」，避免「标着粤语却在说普通话」的错配。
      var vname = Snd.personaName ? Snd.personaName(seat) : '';
      var vreal = Snd.effectiveName ? Snd.effectiveName(seat) : vname;
      var vtag = vname ? '<span class="mk voice' + (vreal !== vname ? ' na' : '') + '" title="'
        + (vreal === vname ? '该玩家的语音口音'
          : '本机没安装「' + vname + '」语音包，这里改用「' + vreal + '」朗读（在 🔊 声音设置里有自检）')
        + '">🎙 ' + esc(vname) + (vreal !== vname ? '→' + esc(vreal) : '') + '</span>' : '';
      // 明牌手牌：地主明牌后，所有人都能在他头像旁看到（本人除外，本人手牌在下方）
      var revealed = '';
      if (st.phase === 'settle' && st.settle && st.settle.remainingHands && st.settle.remainingHands[p.seat]) {
        revealed = '<div class="remain-title">剩余 ' + st.settle.remainingHands[p.seat].length + ' 张</div>'
          + revealedHandHtml(st.settle.remainingHands[p.seat]);
      } else if (p.isLandlord && p.reveal === true && p.hand && p.nick !== me.nick) {
        revealed = revealedHandHtml(p.hand);
      }
      // 剩余牌数：小扑克牌背面作为底，上面写数字（不用汉字）
      var cnt = '<span class="cardcount" title="剩余 ' + p.cardCount + ' 张牌">'
        + '<span class="cc-n">' + p.cardCount + '</span></span>';
      var playedHere = pp !== 'bottom' && st.phase === 'playing' && st.play && st.play.lastPlay
        && st.play.lastPlaySeat === seat ? st.play.lastPlay.cards : null;
      var playedHereSig = playedHere ? playedHere.map(function (c) { return c.id; }).join(',') : '';
      // 注意：倒计时秒数不参与签名比较，由独立定时器原地刷新，
      // 这样座位 DOM 不会每秒被重建，数字才能平滑过渡（不再闪现占位符）。
      var html =
        '<div class="seat-head">'
        + '<div class="avatar">' + esc((p.nick || '?').slice(0, 1)) + '</div>'
        + '<div class="seat-info">'
        + '<div class="nm">' + esc(p.nick) + (p.nick === me.nick ? '<span class="me-tag">我</span>' : '') + '</div>'
        + (role ? '<span class="role ' + (p.isLandlord ? 'll' : 'fm') + '">' + role + '</span>' : '')
        + '</div>'
        + (p.isLandlord ? '<div class="crown" title="地主">👑</div>' : '')
        + '</div>'
        + ((fixedMarks || vtag) ? '<div class="seat-fixed">' + fixedMarks + vtag + '</div>' : '')
        + '<div class="seat-meta"><span class="sc">积分 ' + fmtBig(p.score) + '</span>'
        + (p.connected ? '' : '<span class="off-tag">离线</span>') + cnt + '</div>'
        + (actionMarks ? '<div class="marks seat-actions">' + actionMarks + '</div>' : '')
        + revealed;
      var sig = html + '|' + (isTurn && st.deadline ? 'T' + st.deadline : '-') + '|'
        + (p.connected ? '' : 'off') + '|play:' + playedHereSig;
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig;
        el.innerHTML = html + (isTurn && st.deadline ? clockHtml(st) : '');
        if (playedHere && playedHere.length) {
          var playedEl = document.createElement('div');
          playedEl.className = 'seat-play';
          playedHere.forEach(function (c) { playedEl.appendChild(cardEl(c, { mini: true })); });
          el.appendChild(playedEl);
        }
      } else if (isTurn && st.deadline) {
        var cn = el.querySelector('.clock .clock-num');
        if (cn) syncClockNum(cn, st.deadline);
      }
      renderBubble(seat);
    });
    // 自己出的牌固定显示在牌桌靠近自己一侧的中央，并使用比他人更大的牌面。
    var selfZone = $('selfPlayZone');
    var selfCards = st.phase === 'playing' && st.play && st.play.lastPlay
      && st.play.lastPlaySeat === mySeat ? st.play.lastPlay.cards : null;
    var selfSig = selfCards ? selfCards.map(function (c) { return c.id; }).join(',') : '';
    if (selfZone.dataset.sig !== selfSig) {
      selfZone.dataset.sig = selfSig; selfZone.innerHTML = '';
      if (selfCards) selfCards.forEach(function (c) { selfZone.appendChild(cardEl(c, {})); });
    }
    selfZone.classList.toggle('shown', !!(selfCards && selfCards.length));
    // 触屏移动端把自己的座位内容镜像到牌桌最底边单行栏；原座位框由 CSS 隐藏。
    var mobileSelfBar = $('mobileSelfBar');
    var sourceSelf = document.querySelector('.seat-bottom');
    if (mobileSelfBar && sourceSelf) {
      mobileSelfBar.innerHTML = sourceSelf.innerHTML;
      var revealedMobile = mobileSelfBar.querySelector('.revealed-hand, .remain-title');
      if (revealedMobile) revealedMobile.remove();
    }
    handleInteractions(st);
    handlePasses(st);

    // 底牌（左上角，左大右小）
    var bc = $('bottomCards'); bc.innerHTML = '';
    if (st.bottom) {
      st.bottom.slice().sort(function (a, b) {
        if (a.rank !== b.rank) return b.rank - a.rank;
        return (a.suit || '').localeCompare(b.suit || '');
      }).forEach(function (c) { bc.appendChild(cardEl(c, { mini: true })); });
    } else {
      for (var i = 0; i < 8; i++) bc.appendChild(cardEl({}, { mini: true, back: true }));
    }

    // 上一手牌已在对应出牌者的头像框旁渲染；中央只保留阶段提示。
    var lpSig = playSigOf(st);
    if (st.play && st.play.lastPlay) {
      var lpSeat = st.play.lastPlaySeat;
      var lpPl = lpSeat != null ? st.players[lpSeat] : null;
      var lpInfo = st.play.lastPlay.info;
    }

    // 特殊牌型特效与语音报牌（仅在“新的一手”出现时触发一次）
    if (st.play && st.play.lastPlay) {
      if (lpSig !== prevPlaySig) {
        // 刚进房间/重连时桌面已有上一手：只做同步，不补播动画与语音；
        // 但「新一轮的首手」（包括首手就单出炸弹）必须照样播动画。
        if (sceneReady) {
          var said = playText(lpInfo, st.play.lastPlay.cards);
          if (lpInfo.type === 'bomb') { triggerEffect('炸 弹！', 'fx-bomb'); fxBomb(); Snd.sfx('boom'); bombSting(st.play.lastPlaySeat); }
          else if (lpInfo.type === 'rocket') { triggerEffect('火 箭！', 'fx-rocket'); fxRocket(); Snd.sfx('rocket'); bombSting(st.play.lastPlaySeat); }
          else { Snd.sfx('play'); }
          Snd.speak(said, st.play.lastPlaySeat, 0, lpPl ? lpPl.nick : ''); // 读出牌型，如“对2”“仨K带俩4”
        }
        prevPlaySig = lpSig;
      }
    } else {
      prevPlaySig = null;
    }
    sceneReady = true; // 第一帧之后，任何“新出现的一手”都是真实事件

    // 手牌
    renderHand(st);

    // 操作区
    renderActionBar(st, mySeat);
    // renderActionBar 会先清空操作栏，因此必须在按钮完成重绘后再把本人倒计时
    // 移到按钮右侧；否则移动进去的时钟会立刻随旧按钮一起被删除。
    if (mobileSelfBar) {
      var mobileClock = mobileSelfBar.querySelector('.clock');
      var mobileActionbar = $('actionbar');
      if (mobileClock && mobileActionbar && mobileActionbar.querySelector('button')) {
        mobileClock.classList.add('self-action-clock');
        mobileActionbar.appendChild(mobileClock);
      }
    }
    // 移动端不保留只有等待文案、没有按钮的空操作栏。
    $('actionbar').classList.toggle('has-actions', !!$('actionbar').querySelector('button'));

    // 阶段提示
    $('phaseTip').textContent = phaseTip(st, mySeat);

    // 结算 / 最终榜 弹窗
    if (st.phase === 'settle') { if (!$('modalBox').dataset.settle) showSettle(st); }
    else if (st.phase === 'roomEnd') { if (!$('modalBox').dataset.final) showFinal(st); }
    else {
      if ($('modalBox').dataset.settle) { hide('modal'); $('modal').classList.remove('settle-modal'); delete $('modalBox').dataset.settle; }
    }
  }

  var lastHandSig = '';
  function renderHand(st) {
    if (startCard) return; // 拖拽/点选进行中：不重建手牌，避免打断操作
    var mySeat = seatOf(st, me.nick);
    var p = st.players[mySeat];
    var hand = $('hand');
    if (!p || !p.hand) { hand.innerHTML = '<span class="hint">手牌不可见</span>'; lastHandSig = ''; return; }
    var bombIds = Cards.bombCardIds(p.hand);
    // 大牌在左、小牌在右（rank 降序，同点按花色稳定排序）
    var cards = p.hand.slice().sort(function (a, b) {
      if (a.rank !== b.rank) return b.rank - a.rank;
      return (a.suit || '').localeCompare(b.suit || '');
    });
    // 内容与选中状态都没变时跳过重建（服务端每秒广播，避免无谓刷新）
    var sig = cards.map(function (c) { return c.id + (selected[c.id] ? 's' : '') + (bombIds[c.id] ? 'b' : ''); }).join(',');
    if (sig === lastHandSig) { layoutHand(); return; }
    lastHandSig = sig;
    hand.innerHTML = '';
    cards.forEach(function (c) {
      hand.appendChild(cardEl(c, { bomb: !!bombIds[c.id], selectable: true, selected: !!selected[c.id] }));
    });
    layoutHand(); // 始终像底牌一样覆盖排列，同时保证每张牌露出左上角
  }

  // 手牌始终覆盖排列：默认约露出半张；牌多或屏幕窄时再收紧，但不改变牌面大小。
  function layoutHand() {
    var hand = $('hand');
    if (!hand || !hand.children.length) return;
    var kids = hand.children;
    var cw = kids[0].offsetWidth || 78;
    // 固定只露出左上角，不再为了占满整行而拉开牌距；最后一张自然完整显示。
    var visible = 34;
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (coarse && window.innerWidth <= 480) visible = 18;
    else if (coarse && window.innerWidth <= 768) visible = 20;
    else if (coarse && window.innerWidth <= 1024) visible = 23;
    else if (window.innerWidth <= 480) visible = 23;
    else if (window.innerWidth <= 768) visible = 26;
    else if (window.innerWidth <= 1024) visible = 29;
    var overlap = Math.max(1, cw - visible);
    kids[0].style.marginLeft = '0px';
    for (var i = 1; i < kids.length; i++) kids[i].style.marginLeft = (-overlap) + 'px';
  }

  // 本地即时播报：按下按钮就立刻用「自己的口音」把这句话说出来，不再等服务端
  // 广播回来（那一趟来回就是“按完按钮语音有点延迟”的主要来源）。
  // 服务端广播到达时内容一模一样，会被 speak() 的 1.5s 去重窗口吃掉，不会念两遍。
  function mySeatNo() { return lastState ? seatOf(lastState, me.nick) : null; }
  function sayLocal(text, prio) {
    var s = mySeatNo();
    if (s == null || !text) return;
    Snd.speak(text, s, prio == null ? 1 : prio, me.nick);
  }

  function renderActionBar(st, mySeat) {
    var bar = $('actionbar'); bar.innerHTML = '';
    var imTurn = (st.currentTurnSeat === mySeat);
    if (st.phase === 'bidding' && st.bid.yourTurn) {
      addBtn(bar, '不叫', '', function () { sayLocal('不叫', 1); api('/api/bid', { roomNo: me.roomNo, nick: me.nick, bid: 0 }); });
      [1, 2, 3].forEach(function (v) {
        var dis = v <= st.bid.highest;
        addBtn(bar, v + ' 分', v === 3 ? 'primary' : '', function () {
          sayLocal('叫' + (CN_NUM[v] || v) + '分', 1);
          api('/api/bid', { roomNo: me.roomNo, nick: me.nick, bid: v });
        }, dis);
      });
    } else if (st.phase === 'reveal' && st.reveal.yourTurn) {
      addBtn(bar, '明牌 (×2)', 'primary', function () { sayLocal('明牌', 1); api('/api/reveal', { roomNo: me.roomNo, nick: me.nick, reveal: true }); });
      addBtn(bar, '不明牌', '', function () { api('/api/reveal', { roomNo: me.roomNo, nick: me.nick, reveal: false }); });
    } else if (st.phase === 'multiply') {
      // 加倍阶段：所有人都可以同时选（服务端不排队），选完只显示结果，按钮收起来
      var mv = st.multiply.choices[mySeat];
      var chosen = mv != null;
      var picked = Object.keys(st.multiply.choices || {}).length;
      if (chosen) {
        var done = document.createElement('span'); done.className = 'hint picked';
        done.textContent = '你已选择「' + (mv === 4 ? '超级加倍 ×4' : (mv === 2 ? '加倍 ×2' : '不加倍')) + '」'
          + '　已选 ' + picked + ' / 4，等待其他玩家…';
        bar.appendChild(done);
      } else {
        addBtn(bar, '不加倍', '', function () { sayLocal('不加倍', 1); api('/api/multiply', { roomNo: me.roomNo, nick: me.nick, mult: 1 }); });
        addBtn(bar, '加倍 ×2', '', function () { sayLocal('加倍', 1); api('/api/multiply', { roomNo: me.roomNo, nick: me.nick, mult: 2 }); });
        addBtn(bar, '超级加倍 ×4', 'primary', function () { sayLocal('超级加倍', 1); api('/api/multiply', { roomNo: me.roomNo, nick: me.nick, mult: 4 }); });
        var h = document.createElement('span'); h.className = 'hint';
        h.textContent = '大家同时选，不用等别人（已选 ' + picked + ' / 4）';
        bar.appendChild(h);
      }
    } else if (st.phase === 'playing') {
      var mine = st.players[mySeat];
      if (imTurn) {
        var cannotBeat = !!(st.play.canPass && st.play.lastPlay && mine && mine.hand
          && Rules.canBeatWithHand && !Rules.canBeatWithHand(mine.hand, st.play.lastPlay.info));
        if (cannotBeat) {
          addBtn(bar, '要不起', 'pass-action', function () { sayLocal('不要', 0); api('/api/pass', { roomNo: me.roomNo, nick: me.nick }); }, false);
          var noBeatHint = document.createElement('span'); noBeatHint.className = 'hint no-beat';
          noBeatHint.textContent = '你没有能管的上的牌，5 秒后自动不要';
          bar.appendChild(noBeatHint);
          return;
        }
        addBtn(bar, '不要', 'pass-action', function () { sayLocal('不要', 0); api('/api/pass', { roomNo: me.roomNo, nick: me.nick }); }, !st.play.canPass);
        addBtn(bar, '提示', 'hint-action', suggestPlay, false);
        addBtn(bar, '出牌', 'primary', doPlay, false);
        var s2 = document.createElement('span'); s2.className = 'hint';
        s2.textContent = mine && mine.autoPlay ? '托管中，AI 会自动出牌' : (st.play.canPass ? '轮到你，可出牌或不要' : '轮到你首出');
        bar.appendChild(s2);
      } else {
        var s3 = document.createElement('span'); s3.className = 'hint'; s3.textContent = '等待 ' + (st.players[st.currentTurnSeat] ? st.players[st.currentTurnSeat].nick : '') + ' 出牌…'; bar.appendChild(s3);
      }
    }
  }

  function suggestPlay() {
    api('/api/suggest', { roomNo: me.roomNo, nick: me.nick }).then(function (r) {
      if (!r || r.error) { flash((r && r.error) || '暂时无法提示'); return; }
      clearSelect();
      if (r.pass || !r.cards || !r.cards.length) {
        syncSelectedCards();
        flash(r.pass ? 'AI 建议不要' : 'AI 暂无可出建议');
        return;
      }
      for (var i = 0; i < r.cards.length; i++) selected[String(r.cards[i])] = true;
      syncSelectedCards();
      layoutHand();
      flash('已按 AI 建议选牌');
    });
  }

  function doPlay() {
    var mySeat = seatOf(lastState, me.nick);
    var p = lastState.players[mySeat];
    var byId = {}; (p.hand || []).forEach(function (c) { byId[c.id] = c; });
    var ids = Object.keys(selected).filter(function (id) { return !!byId[id]; });
    if (ids.length === 0) { flash('请先选择要出的牌'); return; }
    // 本地先按服务端同样的规则校验一遍：合法就立刻报牌，不等网络来回
    try {
      var cards = ids.map(function (id) { return byId[id]; });
      var info = Rules.analyze(cards);
      var prev = (lastState.play && lastState.play.lastPlay) ? lastState.play.lastPlay.info : null;
      if (info && (!prev || Rules.beats(info, prev))) Snd.speak(playText(info, cards), mySeat, 0, me.nick);
    } catch (e) {}
    api('/api/play', { roomNo: me.roomNo, nick: me.nick, cards: ids }).then(function (r) {
      if (r.error) flash(r.error); else clearSelect();
    });
  }

  function phaseTip(st, mySeat) {
    if (st.phase === 'bidding') return '叫分阶段';
    if (st.phase === 'reveal') return '明牌阶段';
    if (st.phase === 'multiply') return '加倍阶段 · 所有人同时选择';
    if (st.phase === 'playing') return '';
    if (st.phase === 'settle') return '本局结算';
    if (st.phase === 'roomEnd') return '本房间结束';
    return '';
  }

  // ---------------- 弹窗 ----------------
  function showSettle(st) {
    var box = $('modalBox');
    var s = st.settle; if (!s) return;
    box.className = 'modal-box settle-compact';
    var html = '<h2>' + (s.landlordWin ? '地主胜利' : '农民胜利') + (s.spring ? '（' + (st.settle.landlordWin ? '春天' : '反春') + ' ×2）' : '') + '</h2>';
    html += '<div class="settle-row small">叫分 ' + s.breakdown.C + ' × 炸弹/火箭 ' + s.breakdown.D + ' × 春天/反春 ' + s.breakdown.E + ' × 明牌 ' + s.breakdown.M + ' × 加倍 ' + s.breakdown.X + ' = 总倍数 ' + fmtBig(s.breakdown.totalMult) + '</div>';
    html += '<div class="settle-row">单份积分：<b>' + fmtBig(s.breakdown.single) + '</b></div>';
    html += '<h3>积分变动</h3>';
    for (var i = 0; i < 4; i++) {
      var p = st.players[i]; if (!p) continue;
      var d = s.deltas[i]; if (d == null) continue;
      var sign = d[0] === '-' ? '' : '+';
      html += '<div class="settle-row">' + esc(p.nick) + '（' + (p.isLandlord ? '地主' : '农民') + '）：<span class="settle-delta ' + (d[0] === '-' ? 'minus' : 'plus') + '">' + sign + fmtBig(d) + '</span> → 现 ' + fmtBig(s.scoresAfter[i]) + '</div>';
    }
    html += '<div class="settle-note">各玩家剩余牌已显示在牌桌座位旁</div><div class="close-row"><button id="settleClose">知道了</button></div>';
    box.innerHTML = html;
    box.dataset.settle = '1';
    $('modal').classList.add('settle-modal');
    show('modal');
    if (s.spring) triggerEffect(s.landlordWin ? '春 天！' : '反 春！', 'fx-spring');
    // 结算音效：按自己所在阵营判胜负
    var myS = seatOf(st, me.nick);
    var meP = (myS == null) ? null : st.players[myS];
    Snd.sfx(meP && meP.isLandlord === !!s.landlordWin ? 'win' : 'lose');
    $('settleClose').onclick = function () { hide('modal'); $('modal').classList.remove('settle-modal'); delete box.dataset.settle; };
  }
  function showFinal(st) {
    var box = $('modalBox');
    var list = st.finalBoard || [];
    box.className = 'modal-box';
    $('modal').classList.remove('settle-modal');
    var html = '<h2>本房间最终排行榜</h2>';
    html += '<table class="lb"><tr><th>排名</th><th>昵称</th><th>积分</th><th>胜</th><th>负</th><th>胜率</th><th>地主胜</th><th>农民胜</th><th>炸弹</th><th>火箭</th><th>春/反</th><th>最高倍数</th><th>最高单局</th><th>状态</th></tr>';
    list.forEach(function (p, idx) {
      html += '<tr class="' + (p.nick === me.nick ? 'me' : '') + '"><td>' + (idx + 1) + '</td><td>' + esc(p.nick) + (p.isHost ? '👑' : '') + '</td><td>' + fmtBig(p.score) + '</td><td>' + p.win + '</td><td>' + p.lose + '</td><td>' + (p.winRate * 100).toFixed(0) + '%</td><td>' + p.landlordWin + '</td><td>' + p.farmerWin + '</td><td>' + p.bombCount + '</td><td>' + p.rocketCount + '</td><td>' + p.springCount + '</td><td>' + p.maxMult + '</td><td>' + fmtBig(p.maxScore) + '</td><td>' + (p.exited ? '<span class="exited">已退出</span>' : '在局') + '</td></tr>';
    });
    html += '</table><div class="close-row"><button id="finalClose" class="primary">退出房间</button></div>';
    box.innerHTML = html;
    box.dataset.final = '1';
    show('modal');
    $('finalClose').onclick = function () { delete box.dataset.final; api('/api/leave', { roomNo: me.roomNo, nick: me.nick }).then(goHome); };
  }
  function showLeaderboard(st) {
    var box = $('modalBox');
    box.className = 'modal-box';
    $('modal').classList.remove('settle-modal');
    var list = (st.players || []).filter(function (p) { return !!p; }).sort(function (a, b) {
      var as = BigInt(a.score || '0'), bs = BigInt(b.score || '0');
      if (as !== bs) return as > bs ? -1 : 1;
      if ((b.stats.win || 0) !== (a.stats.win || 0)) return (b.stats.win || 0) - (a.stats.win || 0);
      var ar = a.stats.total ? a.stats.win / a.stats.total : 0;
      var br = b.stats.total ? b.stats.win / b.stats.total : 0;
      if (br !== ar) return br - ar;
      return a.seat - b.seat;
    });
    var html = '<h2>房间排行榜（当前）</h2>';
    html += '<table class="lb"><tr><th>排名</th><th>昵称</th><th>积分</th><th>胜</th><th>负</th><th>胜率</th><th>地主胜</th><th>农民胜</th><th>炸弹</th><th>火箭</th><th>春/反</th></tr>';
    list.forEach(function (p, idx) {
      html += '<tr class="' + (p.nick === me.nick ? 'me' : '') + '"><td class="rank-no">' + (idx + 1) + '</td><td>' + esc(p.nick) + '</td><td>' + fmtBig(p.score) + '</td><td>' + p.stats.win + '</td><td>' + p.stats.lose + '</td><td>' + (p.stats.total ? (p.stats.win / p.stats.total * 100).toFixed(0) : 0) + '%</td><td>' + p.stats.landlordWin + '</td><td>' + p.stats.farmerWin + '</td><td>' + p.stats.bombCount + '</td><td>' + p.stats.rocketCount + '</td><td>' + p.stats.springCount + '</td></tr>';
    });
    html += '</table><div class="close-row"><button id="lbClose">关闭</button></div>';
    box.innerHTML = html; show('modal');
    $('lbClose').onclick = function () { hide('modal'); };
  }
  // ---------------- 玩法规则（顶栏 📖 规则） ----------------
  var RULES_HTML = [
    '<h2>玩法规则</h2>',
    '<div class="rules">',
    '<div class="r-sec"><h3>牌与人数</h3><ul>',
    '<li>两副牌共 <b>108 张</b>（含 4 张王：2 小王、2 大王），4 人一桌。</li>',
    '<li>每人 <b>25 张</b>，剩 8 张作底牌，归地主（地主共 33 张）。</li>',
    '<li>点数大小：<b>3 &lt; 4 &lt; … &lt; 10 &lt; J &lt; Q &lt; K &lt; A &lt; 2 &lt; 小王 &lt; 大王</b>。</li>',
    '</ul></div>',
    '<div class="r-sec"><h3>牌型</h3><table class="r-tb">',
    '<tr><th>牌型</th><th>组成</th><th>说明</th></tr>',
    '<tr><td>单张</td><td>1 张</td><td>包含大小王</td></tr>',
    '<tr><td>对子</td><td>2 张同点</td><td>允许两个同色王；大小王混合不成对</td></tr>',
    '<tr><td>三张</td><td>3 张同点</td><td>不含王</td></tr>',
    '<tr><td>三带二</td><td>三张 + 一对</td><td>本局只保留三带二</td></tr>',
    '<tr><td>顺子</td><td>≥5 张连续单牌</td><td>最大到 A，不含 2 和王</td></tr>',
    '<tr><td>连对</td><td>≥3 对连续对子</td><td>最大到 A，不含 2 和王</td></tr>',
    '<tr><td>飞机</td><td>≥2 组连续三张</td><td>王不参与</td></tr>',
    '<tr><td>飞机带对</td><td>k 组连续三张 + k 个对子</td><td>同色双王可作翼对子</td></tr>',
    '<tr><td>炸弹</td><td>4~8 张同点</td><td>王不能组炸弹</td></tr>',
    '<tr><td>火箭</td><td>2 小王 + 2 大王</td><td>最大，压一切</td></tr>',
    '</table>',
    '<div class="r-note">本局不支持：三带一、飞机带单、四带二、四带两对。</div></div>',
    '<div class="r-sec"><h3>比牌</h3><ul>',
    '<li>只有<b>同牌型、同张数</b>才能比，比关键点数（顺子/连对/飞机比最大的那组）。</li>',
    '<li><b>炸弹</b>可以压任何普通牌型；炸弹之间先比张数、再比点数（4 张 &lt; 5 张 &lt; … &lt; 8 张）。</li>',
    '<li><b>火箭</b>最大，谁都要不起。</li>',
    '<li>连续<b>三家“不要”</b>后，最后出牌的人重新自由出牌（可出任意牌型）。</li>',
    '</ul></div>',
    '<div class="r-sec"><h3>一局流程</h3><ol>',
    '<li><b>叫分</b>：不叫 / 1 / 2 / 3 分，必须高于当前最高分；叫 3 分立即成为地主；首局随机起叫，之后由上一局赢家先叫；<b>无人叫分则流局重发</b>（不计局）。</li>',
    '<li><b>明牌</b>（房主开启时）：地主可选明牌，手牌公开给全场，<b>倍数 ×2</b>。</li>',
    '<li><b>加倍</b>（房主开启时）：<b>四个人同时选</b>，不用排队等别人；不加倍 / 加倍 ×2 / 超级加倍 ×4。</li>',
    '<li><b>出牌</b>：地主先出，轮流出牌或过牌；有人出完牌即本局结束。</li>',
    '</ol></div>',
    '<div class="r-sec"><h3>倍数与积分</h3><ul>',
    '<li><b>总倍数</b> = 叫分 C ×（炸弹/火箭 D）×（春天/反春 E）×（明牌 M）×（加倍 X）。</li>',
    '<li>炸弹倍率：4 张 ×2、5 张 ×4、6 张 ×8、7 张 ×16、8 张 ×32；火箭 ×2；一局内多次出炸弹则<b>连乘</b>。</li>',
    '<li>加倍 X = 四个人各自选择的倍数连乘（×1 / ×2 / ×4）。</li>',
    '<li><b>春天</b>：地主获胜且两个农民一张牌都没出过 → ×2；<b>反春</b>：农民获胜且地主只出过一手牌 → ×2。</li>',
    '<li><b>单份积分</b> = 底分 × 总倍数。地主赢：地主 +3 份、两个农民各 −1 份；农民赢：地主 −3 份、两个农民各 +1 份。</li>',
    '<li>积分<b>不封顶</b>，可为负；房间结束后出最终排行榜。</li>',
    '</ul></div>',
    '<div class="r-sec"><h3>超时与断线</h3><ul>',
    '<li>叫分 / 明牌 / 加倍时长可由房主设置，超时按「不叫 / 不明牌 / 不加倍」处理。</li>',
    '<li>出牌按房间设置的秒数（默认 15 秒）：首出超时自动出最小单张；确认没有牌能压住时，5 秒后自动「不要」，原倒计时照常显示。</li>',
    '<li>有玩家掉线时牌局<b>自动暂停</b>，等他重连后继续。</li>',
    '</ul></div>',
    '</div>',
    '<div class="close-row"><button id="rulesClose" class="primary">知道了</button></div>'
  ].join('');
  function showRules() {
    var box = $('modalBox');
    box.className = 'modal-box rules-modal';
    $('modal').classList.remove('settle-modal');
    box.innerHTML = '<button id="rulesCloseX" class="modal-x" aria-label="关闭规则">✕</button>' + RULES_HTML;
    box.dataset.rules = '1';
    show('modal');
    Snd.sfx('click');
    function closeRules() { delete box.dataset.rules; hide('modal'); box.className = 'modal-box'; }
    $('rulesClose').onclick = closeRules;
    $('rulesCloseX').onclick = closeRules;
  }

  $('modal').addEventListener('click', function (e) {
    var box = $('modalBox');
    if (e.target === $('modal') && box.dataset.rules) { delete box.dataset.rules; hide('modal'); box.className = 'modal-box'; }
  });
  document.addEventListener('keydown', function (e) {
    var box = $('modalBox');
    if (e.key === 'Escape' && box.dataset.rules) { delete box.dataset.rules; hide('modal'); box.className = 'modal-box'; }
  });

  function showPause(st) {
    var box = $('modalBox');
    if (box.dataset.settle || box.dataset.final || box.dataset.pause || box.dataset.rules) return;
    box.className = 'modal-box';
    $('modal').classList.remove('settle-modal');
    box.innerHTML = '<h2>牌局已暂停</h2><div class="settle-row">有玩家断线（' + (st.pausedBy ? st.pausedBy : '') + '），等待其重连，或由房主解散房间。</div><div class="close-row"><button id="pauseClose">知道了</button></div>';
    box.dataset.pause = '1'; show('modal');
    $('pauseClose').onclick = function () { hide('modal'); };
  }
  function hidePause() { var box = $('modalBox'); if (box.dataset.pause) { delete box.dataset.pause; hide('modal'); } }

  // ---------------- 通用 ----------------
  function seatOf(st, nick) { for (var i = 0; i < 4; i++) if (st.players[i] && st.players[i].nick === nick) return i; return null; }
  function addBtn(parent, label, cls, fn, dis) {
    var b = document.createElement('button'); b.textContent = label;
    if (cls) b.className = cls; if (dis) b.disabled = true;
    b.onclick = function () { if (dis) return; Snd.sfx('click'); fn(); };
    parent.appendChild(b); return b;
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  var flashTimer = null;
  function flash(msg) { var m = $('homeMsg'); if ($('room').classList.contains('hidden') && $('game').classList.contains('hidden')) { m.textContent = msg; } else { /* 游戏内提示 */ var t = document.createElement('div'); t.className = 'msg'; t.style.cssText = 'position:fixed;bottom:120px;left:50%;transform:translateX(-50%);background:#fff;padding:8px 16px;border:1px solid #e67e22;color:#e67e22;border-radius:8px;z-index:60'; t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 1800); } }

  // ---------------- 特殊牌型文字特效 ----------------
  function triggerEffect(text, cls) {
    var layer = $('fxLayer'); if (!layer) return;
    var w = document.createElement('div');
    w.className = 'fx-word ' + (cls || '');
    w.textContent = text;
    layer.appendChild(w);
    setTimeout(function () { if (w.parentNode) w.parentNode.removeChild(w); }, 1600);
  }

  // 离开按钮
  $('btnLeaveRoom').onclick = function () { if (confirm('确定退出房间？')) api('/api/leave', { roomNo: me.roomNo, nick: me.nick }).then(goHome); };
  $('btnLeaveGame').onclick = function () { if (confirm('确定退出房间？')) api('/api/leave', { roomNo: me.roomNo, nick: me.nick }).then(goHome); };
  $('btnAutoPlay').onclick = function () {
    if (!lastState) return;
    var seat = seatOf(lastState, me.nick);
    var player = seat == null ? null : lastState.players[seat];
    if (!player || player.isBot) return;
    api('/api/autoplay', { roomNo: me.roomNo, nick: me.nick, enabled: !player.autoPlay }).then(function (r) {
      if (r && r.error) flash(r.error);
    });
  };
  $('btnLb').onclick = function () { if (lastState) showLeaderboard(lastState); };
  $('btnLb2').onclick = function () { if (lastState) showLeaderboard(lastState); };

  // 各阶段的倒计时总时长（毫秒）
  function timerDuration(st) {
    if (st.phase === 'playing') return (st.config.playTimeout || 15) * 1000;
    if (st.phase === 'bidding') return (st.config.bidTimeout || 10) * 1000;
    return (st.config.choiceTimeout || 10) * 1000;
  }
  // 倒计时刷新：原地只更新数字（无刻度/指针/进度条），数字变化时才写 DOM，避免闪烁
  setInterval(function () {
    var clocks = document.querySelectorAll('.clock');
    for (var i = 0; i < clocks.length; i++) {
      var c = clocks[i];
      var num = c.querySelector('.clock-num');
      if (num) syncClockNum(num, c.dataset.dl);
    }
  }, 150);

  // 窗口尺寸变化时重新排版手牌（手机旋转 / PC 缩放窗口）
  window.addEventListener('resize', layoutHand);

  // 解析邀请链接参数（?room=123456&pwd=xxx），并把地址栏还原干净
  function parseInviteParams() {
    var q = {};
    var search = location.search || '';
    if (!search) return null;
    search.replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = i < 0 ? kv : kv.slice(0, i);
      var v = i < 0 ? '' : kv.slice(i + 1);
      try { q[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { q[k] = v; }
    });
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    var room = String(q.room || q.roomNo || '').trim();
    if (!/^\d{4,8}$/.test(room)) return null;
    return { room: room, pwd: q.pwd || q.password || '' };
  }

  // 启动：URL 邀请参数优先，其次自动重连上次房间
  setScreenMode('home');
  var invite = parseInviteParams();
  var saved = localStorage.getItem('ddz');
  if (invite) {
    $('jn_room').value = invite.room;
    $('jn_pwd').value = invite.pwd;
    hide('createPanel'); show('joinPanel');
    var savedNick = '';
    try { savedNick = (JSON.parse(saved || '{}') || {}).nick || ''; } catch (e) { savedNick = ''; }
    $('nick').value = savedNick;
    if (savedNick) {
      me.nick = savedNick; me.roomNo = invite.room; me.password = invite.pwd;
      $('homeMsg').textContent = '收到邀请，正在加入房间 ' + invite.room + ' …';
      api('/api/join', { nick: savedNick, roomNo: invite.room, password: invite.pwd }).then(function (r) {
        if (r && r.error) { $('homeMsg').textContent = '自动加入失败：' + r.error + '（可改个昵称后点「确认加入」）'; return; }
        localStorage.setItem('ddz', JSON.stringify(me));
        enterRoom();
      });
    } else {
      $('homeMsg').textContent = '收到邀请：房间号 ' + invite.room + '，填个昵称后点「确认加入」即可';
    }
  } else if (saved) {
    try { me = JSON.parse(saved); $('nick').value = me.nick; enterRoom(); } catch (e) {}
  }
})();
