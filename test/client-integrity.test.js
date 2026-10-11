const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const appPath = path.join(__dirname, '..', 'public', 'js', 'app.js');
const source = fs.readFileSync(appPath, 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

execFileSync(process.execPath, ['--check', appPath], { stdio: 'pipe' });
assert.match(source, /\bfunction\s+handlePasses\s*\(/, 'handlePasses 必须是可调用的函数声明');
assert.match(source, /\bvar\s+lastTagSig\s*=/, 'lastTagSig 必须在使用前声明');
assert.doesNotMatch(
  source,
  /^\s*[+-]\s{2,}(?:function|var|let|const|if|for|return)\b/m,
  '前端源码中不能残留补丁行首标记'
);
assert.ok(
  source.indexOf('renderActionBar(st, mySeat);') < source.indexOf('mobileActionbar.appendChild(mobileClock);'),
  '移动端本人倒计时必须在操作按钮重绘完成后再挂载'
);
assert.match(source, /function\s+visibleAvatarForSeat\s*\(/, '道具动画必须按可见头像定位');
assert.match(
  styleSource,
  /\.table\s*>\s*\.ia-dock\s*\{[^}]*position\s*:\s*absolute/s,
  '互动入口必须固定在牌桌坐标系内，避免炸弹震动时跳位'
);
assert.match(
  styleSource,
  /\.seat-play \.card, \.self-play-zone \.card \{ width:26px !important; height:36px !important;/,
  '移动端所有已出牌应保持 1.3 倍后的统一尺寸'
);
assert.match(styleSource, /\.table \.seat-left \.revealed-row \{[^}]*justify-content:flex-start;/, '左侧玩家明牌必须左对齐');
assert.match(styleSource, /\.table \.seat-right \.revealed-row \{[^}]*justify-content:flex-end;/, '右侧玩家明牌必须右对齐');
assert.match(source, /webkitRequestFullScreen/, '全屏按钮应兼容旧版 Android WebKit 接口');
assert.match(source, /mozRequestFullScreen/, '全屏按钮应兼容 Firefox 前缀接口');
assert.doesNotMatch(
  source,
  /matchMedia\('\(display-mode: standalone\), \(display-mode: fullscreen\)'\)/,
  '不能把 Android 的 fullscreen 显示模式误判为 iOS 独立模式'
);
assert.match(
  styleSource,
  /\.seat-play\.fx-blast-cards \.card\s*\{[^}]*animation\s*:\s*blastCards/s,
  '炸弹弹跳必须作用于牌面，不能覆盖牌组外层的定位 transform'
);
const fxShakeBody = (styleSource.match(/@keyframes fxShake\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
assert.doesNotMatch(fxShakeBody, /transform\s*:/, '炸弹震屏不能通过位移牌桌实现，以免牌和控件跳位');
const passFn = (source.match(/function showPassAtPlayPosition[\s\S]*?\n  \}/) || [''])[0];
assert.doesNotMatch(passFn, /showBubble\s*\(/, 'PC 端“不要”也必须显示在出牌位置，不能回退到头像气泡');
assert.match(styleSource, /\.seat-left > \.seat-pass-play/, 'PC 端必须定义左侧玩家的过牌位置');
assert.match(styleSource, /\.table > \.self-pass-play/, 'PC 端必须定义本人过牌位置');

console.log('client integrity tests passed');
