/*
 * audio.js — 零素材音效引擎（UMD 风格全局对象：window.DDZAudio）
 * 所有音效与背景音乐均由 Web Audio 实时合成，不需要任何音频文件；
 * 中文朗读（“一张3 / 对2 / 仨K带俩4”等）使用浏览器语音合成：
 *  - 自动优选本机最自然的中文音色（优先 Neural/Natural/在线音色），
 *    并按「口音人设」（普通话/东北话/四川话/广东话/台湾腔/English）挑选音色；
 *  - 口音人设用房间号做种子随机分配，同一房间内各端一致；
 *    需要真音色的口音（粤语/台湾/英文）在本机没装对应语音包时**不会硬凑**，
 *    而是换用本机说得出来的口音（`voiceReport()` 可查，界面「声音设置」里有自检）；
 *  - 播报内容不带玩家昵称，只念内容本身；同一句话 1.5 秒内只播一遍；
 *  - 调度为「立即开口 · 逐句完整」：浏览器同一时刻只能朗读一条语音（Web 规范限制，
 *    无法真正多人同时出声），因此新播报会在浏览器空闲时立刻交给它开口（队列空时
 *    是同步交出，0 等待），正在播的那句一律**不打断**，从头到尾播完为止。
 * 音量与语音设置持久化在 localStorage（带版本号，便于升级默认音量）。
 */
(function (global) {
  'use strict';

  var LS_KEY = 'ddz_audio';
  var LS_VER = 3; // 版本号：低于此版本的旧存档会套用新的“更响”默认音量
  var DEFAULTS = { sfx: 1.0, bgm: 0.75, announce: true };
  var settings = { sfx: DEFAULTS.sfx, bgm: DEFAULTS.bgm, announce: DEFAULTS.announce };

  try {
    var saved = JSON.parse(global.localStorage.getItem(LS_KEY) || '{}');
    if (saved && typeof saved === 'object') {
      if (typeof saved.announce === 'boolean') settings.announce = saved.announce;
      // 老版本存档里的音量（偏小）不沿用，直接升级为更大的新默认值
      if (Number(saved.__v) >= LS_VER) {
        if (typeof saved.sfx === 'number') settings.sfx = clamp01(saved.sfx);
        if (typeof saved.bgm === 'number') settings.bgm = clamp01(saved.bgm);
      }
    }
  } catch (e) { /* 忽略 */ }

  function clamp01(v) { v = Number(v) || 0; return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function save() {
    try { settings.__v = LS_VER; global.localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  var ctx = null, sfxGain = null, bgmGain = null, noiseBuf = null;
  var unlocked = false;

  // ---------------- 音频上下文 ----------------
  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
      return ctx;
    }
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    sfxGain = ctx.createGain();
    sfxGain.gain.value = settings.sfx;
    sfxGain.connect(ctx.destination);
    bgmGain = ctx.createGain();
    bgmGain.gain.value = settings.bgm;
    bgmGain.connect(ctx.destination);
    return ctx;
  }

  // 浏览器要求：音频必须由用户手势解锁
  function unlock() {
    claimAudioSession(); // iOS：申明为 playback 会话，静音拨片下也能出声
    warmup(); // 借首次交互把语音引擎唤醒，避免第一句播报迟迟不开口（与 Web Audio 是否可用无关）
    var c = ensure();
    if (!c) return;
    unlocked = true;
    if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    if (settings.bgm > 0) startBgm();
  }

  // 移动端（尤其 iOS）常见问题：设备上的「静音拨片」会把网页音频整段静掉。
  // Safari 16.4+ 允许网页申明音频会话类型为 playback，从而不受静音开关影响；
  // 其他浏览器没有这个 API，这里静默跳过。
  function claimAudioSession() {
    try { if (global.navigator && global.navigator.audioSession) global.navigator.audioSession.type = 'playback'; } catch (e) {}
  }
  // 从后台切回来 / 从 bfcache 恢复时，音频上下文常被系统挂起，需要重新唤醒，
  // 否则手机上会出现「切出去再回来就没声音了」。
  function keepAlive() {
    claimAudioSession();
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    if (global.speechSynthesis) loadVoices();
    if (settings.bgm > 0 && unlocked) startBgm();
  }
  if (global.document) {
    try {
      global.document.addEventListener('visibilitychange', function () {
        if (!global.document.hidden) keepAlive();
      });
      global.addEventListener('pageshow', keepAlive);
      global.addEventListener('focus', keepAlive);
    } catch (e) {}
  }

  // ---------------- 基础发声原语 ----------------
  function tone(o) {
    if (!ensure()) return;
    var t0 = ctx.currentTime + (o.delay || 0);
    var dur = Math.max(0.02, o.dur || 0.1);
    var osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(Math.max(1, o.f0), t0);
    if (o.f1 != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t0 + dur);
    var g = ctx.createGain();
    var vol = Math.max(0.0002, o.gain == null ? 0.2 : o.gain);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + (o.attack || 0.012));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(o.bus || sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  function getNoise() {
    if (noiseBuf) return noiseBuf;
    var len = Math.floor(ctx.sampleRate * 1.2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  function noise(o) {
    if (!ensure()) return;
    var t0 = ctx.currentTime + (o.delay || 0);
    var dur = Math.max(0.02, o.dur || 0.15);
    var src = ctx.createBufferSource();
    src.buffer = getNoise();
    var flt = ctx.createBiquadFilter();
    flt.type = o.filter || 'lowpass';
    flt.frequency.setValueAtTime(Math.max(20, o.f0 == null ? 2000 : o.f0), t0);
    if (o.f1 != null) flt.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + dur);
    if (flt.type === 'bandpass') flt.Q.value = o.q || 1.2;
    var g = ctx.createGain();
    var vol = Math.max(0.0002, o.gain == null ? 0.25 : o.gain);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + (o.attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt);
    flt.connect(g);
    g.connect(o.bus || sfxGain);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }

  // ---------------- 音效库 ----------------
  var SFX = {
    click: function () { tone({ type: 'square', f0: 900, f1: 620, dur: .06, gain: .06 }); },
    // 出牌：短促的“啪”
    play: function () {
      noise({ f0: 2600, f1: 520, dur: .13, gain: .28 });
      tone({ type: 'triangle', f0: 260, f1: 130, dur: .12, gain: .16 });
    },
    pass: function () { tone({ type: 'sine', f0: 380, f1: 210, dur: .17, gain: .11 }); },
    // 发牌：连续轻响
    deal: function () { for (var i = 0; i < 6; i++) noise({ f0: 3200, f1: 900, dur: .05, gain: .1, delay: i * .07 }); },
    // 炸弹爆炸：低频冲击 + 噪声轰鸣 + 碎片
    boom: function () {
      noise({ f0: 2400, f1: 60, dur: .9, gain: .5 });
      tone({ type: 'sine', f0: 115, f1: 26, dur: .8, gain: .38 });
      noise({ f0: 8000, f1: 2000, dur: .22, gain: .2, filter: 'highpass', delay: .02 });
      noise({ f0: 900, f1: 130, dur: .5, gain: .22, delay: .13 });
    },
    // 火箭升天：呼啸上扬 + 尾焰
    rocket: function () {
      noise({ f0: 260, f1: 5600, dur: .85, gain: .26, filter: 'highpass' });
      tone({ type: 'sawtooth', f0: 170, f1: 1600, dur: .8, gain: .12 });
      tone({ type: 'square', f0: 88, f1: 420, dur: .85, gain: .09 });
    },
    // 投掷呼啸（道具飞行时）
    whoosh: function () {
      noise({ f0: 420, f1: 2600, dur: .3, gain: .15, filter: 'bandpass' });
    },
    // 命中：鸡蛋糊脸
    egg: function () {
      noise({ f0: 1500, f1: 170, dur: .22, gain: .45 });
      tone({ type: 'triangle', f0: 190, f1: 58, dur: .24, gain: .28 });
    },
    // 命中：拖鞋“啪”
    slipper: function () {
      noise({ f0: 4200, f1: 700, dur: .1, gain: .45 });
      tone({ type: 'square', f0: 820, f1: 180, dur: .09, gain: .26 });
    },
    // 命中：送花（轻柔上行音）
    flower: function () {
      [1047, 1319, 1568, 2093].forEach(function (f, i) {
        tone({ type: 'sine', f0: f, dur: .34, gain: .11, delay: i * .07 });
      });
    },
    // 命中：番茄（比鸡蛋更脆的“啪叽”）
    tomato: function () {
      noise({ f0: 3000, f1: 320, dur: .16, gain: .42 });
      tone({ type: 'triangle', f0: 330, f1: 92, dur: .18, gain: .24 });
    },
    // 命中：白菜（闷响 + 叶片散开）
    cabbage: function () {
      noise({ f0: 900, f1: 140, dur: .26, gain: .38, filter: 'lowpass' });
      tone({ type: 'sine', f0: 150, f1: 58, dur: .28, gain: .24 });
    },
    // 命中：大便（湿黏噗嗤）
    poop: function () {
      tone({ type: 'sawtooth', f0: 220, f1: 52, dur: .3, gain: .2 });
      noise({ f0: 520, f1: 90, dur: .34, gain: .3, filter: 'lowpass' });
    },
    // 命中：冰块（玻璃脆裂）
    ice: function () {
      noise({ f0: 7000, f1: 1800, dur: .18, gain: .3, filter: 'highpass' });
      [2093, 2637, 3136].forEach(function (f, i) { tone({ type: 'triangle', f0: f, dur: .14, gain: .12, delay: i * .04 }); });
    },
    // 命中：泼水（哗啦）
    water: function () {
      noise({ f0: 3200, f1: 420, dur: .45, gain: .3, filter: 'bandpass' });
      noise({ f0: 1200, f1: 200, dur: .5, gain: .16, filter: 'lowpass', delay: .12 });
    },
    // 命中：鞭炮（噼啪连响）
    firecracker: function () {
      for (var i = 0; i < 7; i++) noise({ f0: 5000, f1: 900, dur: .05, gain: .28, delay: i * .07 });
      tone({ type: 'square', f0: 90, f1: 40, dur: .3, gain: .16, delay: .5 });
    },
    // 命中：礼物（欢快上行）
    gift: function () {
      [659, 880, 1046, 1318].forEach(function (f, i) { tone({ type: 'triangle', f0: f, dur: .3, gain: .12, delay: i * .06 }); });
    },
    // 命中：敬酒（开瓶“呲”+ 碰杯）
    beer: function () {
      noise({ f0: 6000, f1: 1500, dur: .18, gain: .2, filter: 'highpass' });
      [1568, 2093].forEach(function (f, i) { tone({ type: 'triangle', f0: f, dur: .22, gain: .12, delay: .16 + i * .05 }); });
    },
    // 命中：么么哒（甜甜的双音）
    kiss: function () {
      tone({ type: 'sine', f0: 1200, f1: 1700, dur: .12, gain: .14 });
      tone({ type: 'sine', f0: 1600, f1: 2200, dur: .18, gain: .11, delay: .1 });
    },
    // 命中：钻石（闪亮泛音）
    diamond: function () {
      [1760, 2349, 2794, 3520].forEach(function (f, i) { tone({ type: 'sine', f0: f, dur: .38, gain: .1, delay: i * .05 }); });
    },
    // 命中：皇冠（庄严号角）
    crown: function () {
      [523, 659, 784, 1046, 1318].forEach(function (f, i) { tone({ type: 'triangle', f0: f, dur: .4, gain: .13, delay: i * .09 }); });
    },
    emoji: function () { tone({ type: 'triangle', f0: 680, f1: 1120, dur: .1, gain: .1 }); },
    chat: function () {
      tone({ type: 'sine', f0: 784, dur: .12, gain: .11 });
      tone({ type: 'sine', f0: 1046, dur: .16, gain: .09, delay: .1 });
    },
    win: function () { [523, 659, 784, 1046].forEach(function (f, i) { tone({ type: 'triangle', f0: f, dur: .42, gain: .15, delay: i * .12 }); }); },
    lose: function () { [440, 392, 330, 262].forEach(function (f, i) { tone({ type: 'triangle', f0: f, dur: .42, gain: .13, delay: i * .14 }); }); }
  };

  function sfx(name) {
    if (settings.sfx <= 0) return;
    var f = SFX[name];
    if (!f) return;
    try { ensure(); f(); } catch (e) {}
  }

  // ---------------- 背景音乐（四和弦循环 + 分解和弦） ----------------
  var BGM_BAR = 2.2;
  var BGM_CHORDS = [
    { pad: [261.63, 329.63, 392.00], bass: 130.81, arp: [523.25, 659.25, 783.99, 659.25] }, // C
    { pad: [220.00, 261.63, 329.63], bass: 110.00, arp: [440.00, 523.25, 659.25, 523.25] }, // Am
    { pad: [174.61, 220.00, 261.63], bass: 87.31, arp: [349.23, 440.00, 523.25, 440.00] },  // F
    { pad: [196.00, 246.94, 293.66], bass: 98.00, arp: [392.00, 493.88, 587.33, 493.88] }   // G
  ];
  var bgmTimer = null, bgmIndex = 0, bgmNext = 0;

  function bgmBar() {
    if (!ctx || settings.bgm <= 0) return;
    var t0 = (bgmNext > ctx.currentTime) ? bgmNext : ctx.currentTime + 0.12;
    bgmNext = t0 + BGM_BAR;
    var c = BGM_CHORDS[bgmIndex % BGM_CHORDS.length];
    bgmIndex++;
    var d0 = t0 - ctx.currentTime;
    for (var i = 0; i < c.pad.length; i++) {
      tone({ type: 'sine', f0: c.pad[i], dur: BGM_BAR * .95, gain: .042, attack: .5, delay: d0, bus: bgmGain });
    }
    tone({ type: 'triangle', f0: c.bass, dur: BGM_BAR * .9, gain: .065, attack: .35, delay: d0, bus: bgmGain });
    for (var a = 0; a < 8; a++) {
      var f = c.arp[a % 4] * (a >= 4 ? 2 : 1);
      tone({ type: 'triangle', f0: f, dur: .28, gain: .026, delay: d0 + a * (BGM_BAR / 8), bus: bgmGain });
    }
  }

  function startBgm() {
    if (!ensure()) return;
    if (bgmTimer) return;
    if (settings.bgm <= 0) return;
    if (bgmGain) bgmGain.gain.value = settings.bgm;
    bgmNext = ctx.currentTime + 0.15;
    bgmBar();
    bgmTimer = setInterval(bgmBar, BGM_BAR * 1000);
  }
  function stopBgm() { if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; } }

  // ---------------- 中文语音朗读（不同座位不同音色） ----------------
  var voices = [];
  var voicePool = null;
  function voiceKey(v) { return v ? ((v.name || '') + '/' + (v.lang || '')) : ''; }
  function loadVoices() {
    var before = voices.map(voiceKey).join('|');
    try { voices = global.speechSynthesis ? global.speechSynthesis.getVoices() : []; } catch (e) { voices = []; }
    // 音色列表变了 → 重新挑最优音色，并让口音人设的「可用性判断」重算
    if (voices.map(voiceKey).join('|') !== before) { voicePool = null; effCache = {}; effCacheKey = ''; }
  }
  if (global.speechSynthesis) {
    loadVoices();
    try { global.speechSynthesis.onvoiceschanged = loadVoices; } catch (e) {}
    // 部分浏览器首次 getVoices() 为空，稍后重试几次
    var tries = 0;
    var vt = setInterval(function () {
      loadVoices();
      if (voices.length || ++tries > 12) clearInterval(vt);
    }, 350);
  }

  // 音色自然度打分：优先“神经网络/在线”中文音色，其次常见较自然的音色，
  // 尽量避开最机械的默认音；同一座位尽量固定用同一条音色，保证音色稳定。
  var VOICE_GOOD = /natural|neural|online|premium|enhanced/i;
  var VOICE_NAME = /xiaoxiao|xiaoyi|xiaochen|xiaohan|xiaomeng|xiaomo|xiaoxuan|yunxi|yunyang|yunye|yunjian|yunxia|huihui|kangkang|yaoyao|liang|sweet|female|nan|hu|yun/i;
  function voiceScore(v) {
    var n = ((v.name || '') + ' ' + (v.lang || '')).toLowerCase();
    var s = 0;
    if (VOICE_GOOD.test(n)) s += 120;          // 神经/在线音色，最接近真人
    if (VOICE_NAME.test(n)) s += 45;
    if (/google/.test(n)) s += 45;            // Google 云端音色，流畅度优于老式 SAPI 音色
    if (v.localService === false) s += 12;     // 云端音色通常更自然
    if (/zh[-_]?cn|zh[-_]?hans|mandarin|chinese/i.test(n)) s += 18;
    if (/zh[-_]?(tw|hk)|cantonese/i.test(n)) s -= 25; // 港台音，普通话场景不优先
    if (/eddy|flo|grandma|grandpa|rocko|shelley|sandy|reed|junior|novelty|whisper|bells|boing|bubbles|cellos|trinoids|zarvox|bad news|good news|jester|organ|superstar|wobble/i.test(n)) s -= 200;
    return s;
  }
  var badVoices = {}; // 合成失败过的音色（多为云端音色网络问题），本次会话不再使用
  function getPool() {
    if (voicePool) return voicePool;
    if (!voices.length) loadVoices();
    if (!voices.length) return null;
    var zh = voices.filter(function (v) { return /zh|chinese|mandarin|中文|普通话/i.test((v.lang || '') + ' ' + (v.name || '')); });
    var pool = (zh.length ? zh : voices).filter(function (v) { return !badVoices[v.name]; });
    if (!pool.length) pool = (zh.length ? zh : voices).slice();
    pool.sort(function (a, b) { return voiceScore(b) - voiceScore(a); });
    // 只保留“最好那一档”的音色：若机器上没有多条自然音色，就全用最好的一条，
    // 靠音高/语速区分玩家，而不是硬塞一条明显更机械的音色给某个座位。
    var best = voiceScore(pool[0]);
    var keep = pool.filter(function (v) { return voiceScore(v) >= best - 70; });
    if (!keep.length) keep = [pool[0]];
    voicePool = keep.slice(0, 4);
    return voicePool;
  }
  function pickVoice(seat) {
    var pool = getPool();
    if (!pool || !pool.length) return null;
    return pool[(seat || 0) % pool.length];
  }

  // ---------------- 玩家语音人设（随机分配 · 同一房间内各端一致） ----------------
  // 每个座位随机分到一种「口音人设」：普通话 / 东北话 / 四川话 / 广东话 /
  // 台湾腔 / English。随机种子取自房间号，所以同一房间里每台设备算出来的
  // 分配完全相同（同一个座位上听到的口音不会各播各的）。
  // 口音分两层实现：① 音色 + 音调/语速；② 用词表换词（方言换词、英文整句翻译）。
  var CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

  // 英文人设的词表：把播报里的中文换成英文（按 key 长度从长到短替换，长词优先）
  var EN_MAP = {
    // —— 道具台词（与 app.js 的 ITEMS[*].say 一一对应）——
    '请你吃个鸡蛋': 'an egg for you',
    '送你一个番茄': 'a tomato for you',
    '送你一棵白菜': 'a cabbage for you',
    '送你一只拖鞋': 'a slipper for you',
    '送你一坨大便': 'something nasty for you',
    '给你降降温': 'cool down, buddy',
    '给你泼盆冷水': 'a bucket of cold water for you',
    '给你放串鞭炮': 'firecrackers for you',
    '送你一朵小花': "here's a little flower for you",
    '送你一份礼物': 'a gift for you',
    '敬你一杯酒': 'a toast to you',
    '送你一个么么哒': 'a big kiss for you',
    '送你一颗大钻石': 'a big diamond for you',
    '给你戴上皇冠': 'a crown for you',
    // —— 收到道具后的反应（与 app.js 的 REACT_* 一一对应）——
    '哎哟，谁打我': 'ow! who hit me',
    '过分了啊': 'that is too much',
    '我记住你了': 'i will remember you',
    '别打了别打了': 'stop it, stop it',
    '谁扔的这是': 'who threw that',
    '谢谢老板': 'thank you boss',
    '嘿嘿，真香': 'hehe, so nice',
    '你人真好': 'you are so nice',
    '爱你哟': 'love you',
    '谢谢谢谢': 'thanks, thanks',
    // —— 局内播报 ——
    '超级加倍': 'super double',
    '飞机带对': 'airplane with pairs',
    '不加倍': 'no double',
    '飞机': 'airplane',
    '连对': 'paired run',
    '顺子': 'straight',
    '明牌': 'show cards',
    '炸弹': 'bomb',
    '火箭': 'rocket',
    '不要': 'pass',
    '不叫': 'no bid',
    '叫一分': 'bid one',
    '叫两分': 'bid two',
    '叫三分': 'bid three',
    '加倍': 'double',
    '大王': 'big joker',
    '小王': 'small joker',
    '带俩': ' with two ',
    '仨': 'three ',
    '对': 'pair of ',
    '一张': '',
    '个': ' ',
    '尖': 'A', '凯': 'K', '圈': 'Q', '勾': 'J', '十': 'ten',
    '到': ' to ',
    '！': '!', '，': ', ', '：': ': ', '、': ', '
  };

  // 每种口音人设：
  //   match / avoid —— 本机「真正能发出这种口音」的音色特征（avoid 用于排除误伤：
  //                    例如普通话音色不能匹配到港台音，粤语也不能只凭「zh」就认领）
  //   requireReal  —— 必须找到真正对应语言的音色才启用；找不到就换用别的口音，
  //                    绝不用普通话音色硬读粤语/英语（那听起来根本不是粤语，是音源错配）
  //   dict         —— 换词表；只有在「真的用上了该口音音色」时才会套用
  var CN_STD_RE = /zh[-_]?(cn|hans)|mandarin|kangkang|huihui|yaoyao|xiaoxiao|xiaoyi|yunxi|yunyang|yunxia|yunye|yunjian|xiaomo|xiaoxuan|xiaohan|xiaomeng|xiaoqiu|xiaorui|xiaoshuang|xiaoyan|xiaoyou|yunfeng|yunhao|yunze|普通话|中文/i;
  // 非普通话的华语/外语音色特征：普通话音色绝不能匹配到它们
  var CN_NOT_STD_RE = /zh[-_]?(hk|tw|hant)|cantonese|yue|粵|粤|hiugaai|wanlung|hiumaan|sinji|tracy|danny|hsiaochen|yating|hanhan|meijia|english|liaoning|xiaobei|shaanxi|xiaoni/i;
  var PERSONAS = [
    { id: 'std', name: '普通话', lang: 'zh-CN', pitch: 1.00, rate: 1.05,
      match: CN_STD_RE, avoid: CN_NOT_STD_RE },
    { id: 'db', name: '东北话', lang: 'zh-CN', pitch: 0.92, rate: 1.16,
      match: /xiaobei|liaoning|dongbei|东北/i,
      dict: { '不要': '别介', '明牌': '亮牌', '超级加倍': '超级翻番', '加倍': '翻番', '什么': '啥' } },
    // 本机没有「四川话音色」这种语音包（各家 TTS 都没有），这一档是「腔调模仿」：
    // 普通话底子 + 语速/音高 + 川渝用词。标签里会标注为「模仿」。
    { id: 'sc', name: '四川话', lang: 'zh-CN', pitch: 1.14, rate: 0.95, mimic: true,
      dict: { '不要': '不要咯', '不叫': '不叫咯', '明牌': '亮牌', '什么': '啥子' } },
    { id: 'yue', name: '广东话', lang: 'zh-HK', pitch: 0.98, rate: 1.00, requireReal: true,
      match: /yue|cantonese|zh[-_]hk|hiugaai|wanlung|hiumaan|sinji|tracy|danny|粵|粤|廣東|广东/i,
      dict: { '不要': '唔要', '不叫': '唔叫' } },
    { id: 'tw', name: '台湾腔', lang: 'zh-TW', pitch: 1.18, rate: 0.94, requireReal: true,
      match: /zh[-_]tw|hant|hsiaochen|hsiaoyu|yunjhe|yating|hanhan|zhiwei|meijia|美佳|台湾|臺灣/i,
      dict: { '不要': '不要啦', '明牌': '亮牌', '超级加倍': '超级加倍啦' } },
    { id: 'en', name: 'English', lang: 'en-US', pitch: 1.00, rate: 1.02, latin: true, requireReal: true,
      match: /^en([-_]|$)|english/i,
      dict: EN_MAP }
  ];

  function hashStr(s) {
    var h = 2166136261;
    s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // 人设分配：用房间号做种子洗牌，同一房间内各座位拿到的口音顺序完全一致
  var voiceSeed = 'ddz', personaOrder = null, personaOrderSeed = null, personaCache = {};
  function orderOf() {
    if (!personaOrder || personaOrderSeed !== voiceSeed) {
      var idx = [];
      for (var i = 0; i < PERSONAS.length; i++) idx.push(i);
      var rnd = mulberry32(hashStr(voiceSeed));
      for (var j = idx.length - 1; j > 0; j--) {
        var k = Math.floor(rnd() * (j + 1));
        var t = idx[j]; idx[j] = idx[k]; idx[k] = t;
      }
      personaOrder = idx; personaOrderSeed = voiceSeed; personaCache = {};
      effCache = {}; effCacheKey = '';
    }
    return personaOrder;
  }
  function personaOf(seat) {
    var s = (((seat || 0) % 4) + 4) % 4;
    if (personaCache[s]) return personaCache[s];
    var order = orderOf();
    var p = PERSONAS[order[s % order.length]];
    personaCache[s] = p;
    return p;
  }
  // 本机到底能不能发出这种口音：需要真音色的口音，本机没装对应语音包就不可用
  function personaUsable(p) { return !p.requireReal || !!findVoice(p); }
  // 实际生效的口音：从分配到的口音出发，顺着洗牌顺序找第一个「本机发得出来」的。
  // 例如本机没装粤语语音包 → 坐「广东话」的这位改用下一种可用口音，
  // 而不是用普通话硬读「唔要」（那才是真正的音源错配）。
  var effCache = {}, effCacheKey = '';
  function effectivePersona(seat) {
    var s = (((seat || 0) % 4) + 4) % 4;
    var key = voiceSeed + '|' + voices.length + '|' + Object.keys(badVoices).length;
    if (effCacheKey !== key) { effCacheKey = key; effCache = {}; }
    if (effCache[s]) return effCache[s];
    var order = orderOf();
    var start = s % order.length;
    var out = PERSONAS[0];
    for (var k = 0; k < order.length; k++) {
      var p = PERSONAS[order[(start + k) % order.length]];
      if (personaUsable(p)) { out = p; break; }
    }
    effCache[s] = out;
    return out;
  }
  function setVoiceSeed(seed) {
    var v = String(seed == null ? '' : seed);
    if (!v || v === voiceSeed) return;
    voiceSeed = v; personaOrder = null; personaCache = {};
    effCache = {}; effCacheKey = '';
  }
  function personaName(seat) { return personaOf(seat).name; }

  // 音色的「全名」：名称 + 语言 + voiceURI，三处任一命中都算（各平台命名不统一）
  function voiceText(v) {
    return ((v && v.name) || '') + ' ' + ((v && v.lang) || '') + ' ' + ((v && v.voiceURI) || '');
  }
  function voiceMatches(v, p) {
    if (!p || !p.match) return false;
    var t = voiceText(v);
    if (!p.match.test(t)) return false;
    if (p.avoid && p.avoid.test(t)) return false;  // 排除误伤（如普通话不准认领港台音色）
    return true;
  }
  // 按人设规则挑音色（找不到返回 null，由调用方决定是否退回普通话音色）
  function findVoice(p) {
    if (!p || !p.match) return null;
    if (!voices.length) loadVoices();
    if (!voices.length) return null;
    var cands = voices.filter(function (v) { return !badVoices[v.name] && voiceMatches(v, p); });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return voiceScore(b) - voiceScore(a); });
    return cands[0];
  }
  // 本机是否装了中文（普通话）音色：没有的话中文播报会是乱码，需要提示用户
  function hasChineseVoice() {
    if (!voices.length) loadVoices();
    return voices.some(function (v) { return /zh[-_]?(cn|hans)|chinese|mandarin|普通话|中文/i.test(voiceText(v)); });
  }
  // 词表替换（长 key 优先，避免「超级加倍」被「加倍」先吃掉）
  function dictReplace(text, map) {
    var keys = Object.keys(map).sort(function (a, b) { return b.length - a.length; });
    var out = String(text);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (out.indexOf(k) >= 0) out = out.split(k).join(map[k]);
    }
    return out;
  }
  // 组装一句话：口音人设 → 音色 + 语言 + 音调语速 + 换词。
  // 注意：播报不再带玩家昵称（只念内容本身，如「对2」「不要」「送你一朵小花」）。
  function buildSay(text, seat) {
    var p = effectivePersona(seat);
    var body = String(text);
    var latin = !!p.latin;
    var exact = findVoice(p);
    // 英文人设：万一本机没有英文音色（正常已被 requireReal 过滤掉）→ 退回普通话
    if (latin && !exact) {
      p = PERSONAS[0];
      latin = false;
      exact = findVoice(p);
    }
    var voice = exact || (getPool() ? getPool()[0] : null);
    // 换词表只在真的用上了该口音的音色时才套用（否则换出来的词会被普通话读岔）
    if (p.dict) {
      var t = dictReplace(body, p.dict);
      if (latin && CJK_RE.test(t)) {
        // 翻译不干净（多为玩家自定义中文快捷语）→ 退回普通话音色照读，不做半中半英
        p = PERSONAS[0];
        latin = false;
        voice = findVoice(p) || (getPool() ? getPool()[0] : null);
      } else {
        body = t;
      }
    }
    return { text: body, persona: p, voice: voice };
  }

  // ---------------- 朗读调度：立即开口 · 逐句完整 ----------------
  // 平台事实（浏览器规范决定，改不了）：同一个页面里 speechSynthesis 只有一条
  // 「全局朗读队列」，多条 utterance 无法真正同时出声 —— 后一条一定被排在
  // 前一条之后（Chrome 甚至不支持在 iframe 里朗读，分页面也没用）。
  // 这里做两件事，把「排队感」降到最低，同时保证每句话都完整：
  //   1) 立即派发：浏览器一空闲就马上把下一条交给它，队列空时是**同步交出**
  //      （0 等待），连续多条才用 60ms 间隔隔开（避开 Chrome 89+ 连续 speak()
  //      被静默丢弃）。所以按下按钮到开口只有一个网络/渲染来回的延迟。
  //   2) 绝不打断：正在播的那句从头到尾播完才轮到下一条，不调用 cancel()
  //      （只有主动关语音 / 离开房间才清空），因此不会留下半句话。
  // 另外：同一座位同一句话 1.5s 内去重；积压过多时整条丢弃最不重要的那些。
  var lastSayAt = {}, sayQ = [], feedTimer = null, lastFeedAt = 0;
  var speakingFlag = false;  // 是否正在播（onstart/onend 维护，用于让队列等它播完）
  var curU = null;           // 当前真正该播的那条 utterance（用来忽略被取消者的迟到回调）
  var skippedSay = 0;        // 因为本机没有中文音色而放弃朗读的条数（供自检显示）
  var SAY_WINDOW = 1500;     // 同一句去重窗口
  var SAY_MAX_Q = 4;         // 本地待发队列上限（超出丢最不重要的整条）
  var SAY_GAP_MS = 60;       // 相邻两条交给浏览器队列的最小间隔
  var SAY_TICK_MS = 25;      // 进给器节拍（配合上面的间隔，最多晚 60ms 交出）
  var SAY_BACKLOG_MS = 3200; // 待发语音总时长超过这个数就开始丢最不重要的

  // 粗略估算一条语音的时长（中文 TTS 大约 4~5 字/秒 + 引擎起音开销），
  // 用来判断“还有多少话没说完”，只看我们自己的待发队列。
  function estSayMs(text) { return Math.min(6000, 300 + String(text).length * 240); }
  function pendingSayMs() {
    var t = 0;
    for (var i = 0; i < sayQ.length; i++) t += estSayMs(sayQ[i].text);
    return t;
  }

  function canSay() {
    return !!(global.speechSynthesis && typeof global.SpeechSynthesisUtterance === 'function'
      && settings.announce && settings.sfx > 0);
  }

  function makeUtterance(text, seat) {
    var u;
    try {
      var built = buildSay(text, seat);
      var p = built.persona, vs = built.voice;
      // 本机连中文音色都没有（例如安卓没装中文语音数据）时不要硬读：
      // 用英文音色念中文只会得到一串乱码，宁可不出声，并在自检面板里提示。
      if (CJK_RE.test(built.text) && vs && vs.lang && !/^zh/i.test(vs.lang)) { skippedSay++; return null; }
      u = new global.SpeechSynthesisUtterance(built.text);
      u.lang = p.lang || 'zh-CN';
      // 同一人设下的座位微差：即使两人设相同，听感也不会完全一样
      var jit = 1 + ((((seat || 0) % 4) - 1.5) * 0.02);
      u.pitch = Math.max(0.1, Math.min(2, (p.pitch || 1) * jit));
      u.rate = Math.max(0.5, Math.min(2, (p.rate || 1) * (1 + (jit - 1) / 2)));
      u.volume = clamp01(settings.sfx);
      if (vs) { u.voice = vs; if (vs.lang) u.lang = vs.lang; }
    } catch (e) { return null; }
    return u;
  }

  function isBusy() {
    if (speakingFlag) return true;
    try { return !!(global.speechSynthesis && global.speechSynthesis.speaking); } catch (e) { return false; }
  }
  function speechCancel() {
    try { if (global.speechSynthesis) global.speechSynthesis.cancel(); } catch (e) {}
  }
  function stopFeeder() { if (feedTimer) { clearInterval(feedTimer); feedTimer = null; } }
  function startFeeder() {
    if (feedTimer) return;
    feedTimer = setInterval(function () {
      if (!canSay() || !sayQ.length) { stopFeeder(); if (!canSay()) sayQ.length = 0; return; }
      pump();
    }, SAY_TICK_MS);
  }

  // 把一条交给浏览器朗读，并记录“正在播”的状态（onend/onerror 后自动续播）
  function buildAndSpeak(item) {
    var ss = global.speechSynthesis;
    if (!ss) return false;
    var u = makeUtterance(item.text, item.seat);
    if (!u) return false;
    // 浏览器对 cancel() 的处理不统一：有的会补发 onerror('canceled')，有的会先补一个
    // onstart 再结束。所以用 curU 记录「当前真正该播的那句」，回调里先比对身份，
    // 已经被取消/替换掉的旧 utterance 一律忽略，避免它的回调把状态改乱。
    curU = u;
    u.onstart = function () { if (curU !== u) return; speakingFlag = true; };
    u.onend = function () { if (curU !== u) return; curU = null; speakingFlag = false; pump(); };
    u.onerror = function (ev) {
      if (curU !== u) return;
      curU = null; speakingFlag = false;
      var err = ev && ev.error;
      if (err === 'interrupted' || err === 'canceled') { pump(); return; } // 主动关语音/离房导致，正常
      // 云端音色偶发合成失败：换音色补播一次，避免整句丢失
      var v = u.voice;
      if (v && v.name) { badVoices[v.name] = 1; voicePool = null; }
      if (!item.retried) sayQ.unshift({ text: item.text, seat: item.seat, prio: item.prio || 0, retried: true });
      pump();
    };
    try { ss.speak(u); } catch (e) { curU = null; speakingFlag = false; return false; }
    speakingFlag = true;
    return true;
  }
  // 队列有货、且浏览器空闲时，尽快交下一条出去（正在播就等它播完，绝不打断）
  function pump() {
    if (!canSay()) { sayQ.length = 0; stopFeeder(); return; }
    if (!sayQ.length) { stopFeeder(); return; }
    if (isBusy()) return;                 // 正在播：等它完整播完
    var now = Date.now();
    if (now - lastFeedAt < SAY_GAP_MS) { startFeeder(); return; }
    lastFeedAt = now;
    buildAndSpeak(sayQ.shift());
    if (sayQ.length) startFeeder();
  }

  // 引擎预热：首次朗读要等引擎加载（几百 ms 甚至 1s+），
  // 在首次交互时先用零音量空串把引擎唤醒，真正开口时就没有这段延迟。
  // 各座位实际用到的口音音色都预热一遍（错开 120ms，避开连续 speak() 被丢弃）。
  var warmed = false;
  function warmup() {
    var ss = global.speechSynthesis;
    if (!ss || typeof global.SpeechSynthesisUtterance !== 'function') return;
    loadVoices(); // 移动端首次交互后音色列表才齐，这里再抓一次
    if (warmed) return;
    warmed = true;
    var seen = {}, list = [];
    for (var s = 0; s < 4; s++) {
      var v = findVoice(effectivePersona(s)) || pickVoice(s);
      var key = v ? (v.name || v.voiceURI) : ('__' + s);
      if (seen[key]) continue;
      seen[key] = 1;
      list.push(v);
    }
    list.forEach(function (v, i) {
      setTimeout(function () {
        try {
          var u = new global.SpeechSynthesisUtterance('。');
          u.volume = 0; u.rate = 2; u.lang = 'zh-CN';
          if (v) { u.voice = v; if (v.lang) u.lang = v.lang; }
          ss.speak(u);
        } catch (e) {}
      }, i * 120);
    });
  }

  // nick 参数保留兼容，但播报内容里不再拼昵称（口播只念内容本身）。
  function speak(text, seat, prio, nick) {
    void nick;
    if (!text || !canSay()) return;
    var s = seat || 0;
    var key = s + '|' + text;
    var now = Date.now();
    if (lastSayAt[key] && now - lastSayAt[key] < SAY_WINDOW) return; // 去重：同一句只播一遍
    for (var k in lastSayAt) { if (now - lastSayAt[k] > SAY_WINDOW * 6) delete lastSayAt[k]; }
    lastSayAt[key] = now;

    var item = { text: String(text), seat: s, prio: prio || 0 };
    // 按优先级插队（越重要的越靠前），同级保持先后顺序：
    //   2 = 自己发的快捷语/道具  1 = 叫分/加倍/明牌  0 = 出牌报牌
    // 只调整「还没交出去」的顺序，正在播的那条不受影响，照旧播完。
    var at = sayQ.length;
    for (var i = 0; i < sayQ.length; i++) {
      if (sayQ[i].prio < item.prio) { at = i; break; }
    }
    sayQ.splice(at, 0, item);
    // 积压太多就丢掉最不重要的整条，保证新消息尽快开口
    while (sayQ.length > 1 && (sayQ.length > SAY_MAX_Q || pendingSayMs() > SAY_BACKLOG_MS)) {
      var worst = 0;
      for (var j = 1; j < sayQ.length; j++) if (sayQ[j].prio < sayQ[worst].prio) worst = j;
      sayQ.splice(worst, 1);
    }
    pump();
  }

  // 清空朗读队列。soft=true 时只丢弃“还没交出去”的语音，
  // 已经交给浏览器的那条会照常播完（不留半句话）。
  function stopSay(soft) {
    sayQ.length = 0;
    stopFeeder();
    if (soft) return;     // 只丢弃还没交出去的；正在播的那条照常播完，状态不动
    curU = null;          // 先断掉身份，旧 utterance 的迟到回调就不会改状态
    speakingFlag = false;
    speechCancel();
  }
  // 设置变化后重置去重记录，让下一次播报不被旧的节流拦住
  function resetSayThrottle() { lastSayAt = {}; }

  function setSfx(v) {
    settings.sfx = Math.max(0, Math.min(1, Number(v) || 0));
    if (sfxGain && ctx) { try { sfxGain.gain.setTargetAtTime(settings.sfx, ctx.currentTime, .05); } catch (e) { sfxGain.gain.value = settings.sfx; } }
    save();
  }
  function setBgm(v) {
    settings.bgm = Math.max(0, Math.min(1, Number(v) || 0));
    if (bgmGain && ctx) { try { bgmGain.gain.setTargetAtTime(settings.bgm, ctx.currentTime, .05); } catch (e) { bgmGain.gain.value = settings.bgm; } }
    if (settings.bgm <= 0) stopBgm();
    else if (unlocked) startBgm();
    save();
  }
  function setAnnounce(on) {
    settings.announce = !!on;
    if (!settings.announce) stopSay();
    resetSayThrottle();
    save();
  }

  // ---------------- 自检：告诉用户本机到底有哪些音色、各座位实际会说哪种口音 ----------------
  // 移动端最常见的问题就是「系统没装中文语音数据」，此时中文播报会变成乱码，
  // 所以这里把检测结果交给界面显示，而不是让用户去猜。
  function voiceReport() {
    loadVoices();
    var personas = PERSONAS.map(function (p) {
      var v = findVoice(p);
      return {
        id: p.id, name: p.name,
        needReal: !!p.requireReal,
        mimic: !!p.mimic,
        real: !!v,
        voice: v ? (v.name + (v.lang ? ' [' + v.lang + ']' : '')) : ''
      };
    });
    var seats = [0, 1, 2, 3].map(function (s) {
      var a = personaOf(s), e = effectivePersona(s);
      var row = personas.filter(function (x) { return x.id === e.id; })[0];
      return {
        seat: s, assigned: a.name, effective: e.name, changed: a.id !== e.id,
        // 本机没有这种口音的专用音色 → 只能用普通话音色模仿音调/用词
        mimic: !(row && row.real) && !e.requireReal
      };
    });
    return {
      count: voices.length,
      hasChinese: hasChineseVoice(),
      skipped: skippedSay,
      personas: personas,
      seats: seats
    };
  }

  var api = {
    settings: settings,
    unlock: unlock,
    startBgm: startBgm,
    stopBgm: stopBgm,
    setSfx: setSfx,
    setBgm: setBgm,
    setAnnounce: setAnnounce,
    sfx: sfx,
    speak: speak,
    // 试听/自检用：跳过 1.5s 去重，立刻念（界面上的「🔈 试听一句」按钮）
    preview: function (text, seat) { lastSayAt = {}; speak(text, seat || 0, 2); },
    stopSay: stopSay,
    loadVoices: loadVoices,
    voiceReport: voiceReport,     // 音色/口音自检（移动端排查发声问题用）
    setVoiceSeed: setVoiceSeed,   // 传入房间号：同一房间内各端分到同一套口音
    personaName: personaName,     // 座位 -> 分配到的口音名（“东北话”等），供界面展示
    effectiveName: function (seat) { return effectivePersona(seat).name; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DDZAudio = api;
})(typeof window !== 'undefined' ? window : globalThis);
