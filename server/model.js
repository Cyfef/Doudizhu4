/*
 * model.js — 神经网络价值网络 V(s,a) 的纯 JS 前向（服务端，零依赖）
 *
 * 为什么手写而不是引框架：本项目服务端坚持零依赖（只有 Node 内置模块）。
 * 网络很小（66→256→128→1），一次决策约几十次点积，手写前向完全够用。
 *
 * 已部署权重以 base64(Float32) 形式保存在 server/model.json。本模块负责：
 *   1) 懒加载 + 解析（首次用到才读盘，读不到就降级，绝不让房间起不来）；
 *   2) 把权重转置成 [out][in] 布局，让内层循环连续访存（点积快很多）；
 *   3) forwardBatch：一次给「全部候选动作」打分（比逐个调用快一个量级）。
 *
 * 网络结构：
 *   隐藏层 ReLU，输出层 tanh → V ∈ [-1, 1]，对应 DMC 的终局回报 ±1。
 *   z = x @ W[i] + b[i]
 */
'use strict';

var fs = require('fs');
var path = require('path');

var MODEL_PATH = path.join(__dirname, 'model.json');

// 模块级单例：进程内只加载一次
var S = {
  tried: false,
  loaded: false,
  layers: null,
  W: null,      // 已转置：W[i] 布局为 [out][in]
  b: null,
  meta: null,
  err: null
};

function b64ToF32(s) {
  var buf = Buffer.from(s, 'base64');
  var n = buf.length >> 2;
  var out = new Float32Array(n);
  for (var i = 0; i < n; i++) out[i] = buf.readFloatLE(i << 2);
  return out;
}

// [in][out] 行主序 → [out][in]；点积时两个数组都连续访存
function transpose(w, inDim, outDim) {
  var out = new Float32Array(inDim * outDim);
  for (var i = 0; i < inDim; i++) {
    var src = i * outDim;
    for (var o = 0; o < outDim; o++) out[o * inDim + i] = w[src + o];
  }
  return out;
}

/**
 * 加载权重。失败不抛错，只记录 err 并置 loaded=false（调用方降级到启发式）。
 */
function load(p) {
  S.tried = true;
  try {
    var obj = JSON.parse(fs.readFileSync(p || MODEL_PATH, 'utf8'));
    if (!obj || !obj.W || !obj.b || !obj.layers) throw new Error('model.json 结构不对');
    var layers = obj.layers;
    if (obj.W.length !== layers.length - 1) throw new Error('层数与权重个数不匹配');
    S.W = [];
    S.b = [];
    for (var i = 0; i < obj.W.length; i++) {
      var w = b64ToF32(obj.W[i]);
      if (w.length !== layers[i] * layers[i + 1]) throw new Error('W[' + i + '] 长度不对');
      S.W.push(transpose(w, layers[i], layers[i + 1]));
      var bb = b64ToF32(obj.b[i]);
      if (bb.length !== layers[i + 1]) throw new Error('b[' + i + '] 长度不对');
      S.b.push(bb);
    }
    S.layers = layers;
    S.meta = obj.meta || {};
    S.loaded = true;
  } catch (e) {
    S.err = e;
    S.loaded = false;
  }
  return S.loaded;
}

/** 是否可用（首次调用会尝试加载）。 */
function ready() {
  if (!S.tried) load();
  return S.loaded;
}

function inputDim() { return S.layers ? S.layers[0] : 0; }
function info() {
  return { loaded: S.loaded, layers: S.layers, meta: S.meta, error: S.err ? String(S.err.message || S.err) : null };
}

/**
 * 批量前向：X 为 rows × inputDim 的行主序数组，返回 Float64Array(rows) = 每个样本的 V。
 * 一次性算完所有候选动作，比分多次调用快得多（矩阵乘法对缓存更友好）。
 */
function forwardBatch(X, rows) {
  if (!ready()) return null;
  if (rows <= 0) return new Float64Array(0);
  var layers = S.layers;
  var cur = (X instanceof Float32Array) ? X : Float32Array.from(X);
  var curRows = rows;
  var nLayers = S.W.length;
  for (var li = 0; li < nLayers; li++) {
    var inDim = layers[li], outDim = layers[li + 1];
    var Wt = S.W[li], bb = S.b[li];
    var out = new Float32Array(curRows * outDim);
    var isLast = (li === nLayers - 1);
    for (var r = 0; r < curRows; r++) {
      var xo = r * inDim, oo = r * outDim;
      for (var o = 0; o < outDim; o++) {
        var s = bb[o], wo = o * inDim;
        for (var i = 0; i < inDim; i++) s += cur[xo + i] * Wt[wo + i];
        out[oo + o] = isLast ? Math.tanh(s) : (s > 0 ? s : 0);
      }
    }
    cur = out;
  }
  var V = new Float64Array(curRows);
  for (var r2 = 0; r2 < curRows; r2++) V[r2] = cur[r2];
  return V;
}

/** 单条样本前向（测试/调试用）。 */
function forwardOne(x) {
  var V = forwardBatch(x, 1);
  return V ? V[0] : null;
}

module.exports = {
  MODEL_PATH: MODEL_PATH,
  load: load,
  ready: ready,
  inputDim: inputDim,
  info: info,
  forwardBatch: forwardBatch,
  forwardOne: forwardOne,
  // 测试用：重置单例，便于测「模型缺失」的降级路径
  _reset: function () { S.tried = false; S.loaded = false; S.W = null; S.b = null; S.layers = null; S.err = null; }
};
