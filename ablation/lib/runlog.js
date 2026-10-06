'use strict';
/**
 * 工作台的运行日志落盘（tee 到文件）。
 *
 * 为什么需要它：测试是在**别人的机器**上跑的。出错时屏幕上滚过去的东西，
 * 等人来问的时候已经没了 —— 诊断包里必须带一份"当时终端到底说了什么"，
 * 否则"我这边跑出来不对"这句话连个可查的现场都没有。
 *
 * 两条纪律：
 *   ① 日志写不进去**绝不能拖垮主流程**（目录不可写 / 磁盘满 → 降级成"只打屏幕"，
 *      并在屏幕上如实说一句），日志是给排查用的，不能成为新的故障点；
 *   ② 文件只在启动时打开一次，超上限就从"前半截"砍（日志是给人读的，
 *      最新的一段比最早的一段有用）。
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 8 * 1024 * 1024;

const pad = (n) => String(n).padStart(2, '0');
/** 本地时间（测试者屏幕上看到的就是本地时间，别用 UTC 让他对不上）。 */
function stamp(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate())
    + ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds());
}

function fmt(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
  if (a === null || a === undefined) return String(a);
  if (typeof a === 'number' || typeof a === 'boolean') return String(a);
  try { return JSON.stringify(a); } catch { return String(a); }
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/**
 * 开始 tee。
 * @param {string} file 日志文件（一般是 <跑分数据目录>/server.log）
 * @param {{banner?:string, maxBytes?:number}} [opts]
 * @returns {{file:string,size:()=>number,note:()=>string,stop:()=>void}}
 */
function start(file, opts) {
  const o = opts || {};
  const maxBytes = Number(o.maxBytes) > 0 ? Number(o.maxBytes) : MAX_BYTES;
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  let ok = false;                 // 能落盘吗（不能就只打屏幕）
  let broken = null;
  let bytes = 0;
  let stopped = false;

  // 同步写：① 诊断包可能在**任何一行日志之前**就来读这个文件，异步流会让文件还没建出来；
  // ② 崩溃（uncaughtException）那一条必须已经落在盘上，异步流里的缓冲会随进程一起消失。
  // 工作台一天也就几万行，同步写的代价换"现场一定在"，值。
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, '');
    bytes = fs.statSync(file).size;
    ok = true;
  } catch (e) {
    broken = e;
    ok = false;
  }

  function rotate() {
    if (!ok) return;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const keep = text.slice(Math.floor(text.length / 2));
      const at = keep.indexOf('\n');           // 从整行开始，别从半行切
      const tail = at >= 0 ? keep.slice(at + 1) : keep;
      fs.writeFileSync(file, '[日志超过 ' + humanBytes(maxBytes) + '，前半截已丢弃]\n' + tail, 'utf8');
      bytes = Buffer.byteLength(tail, 'utf8') + 40;
    } catch (e) { broken = e; ok = false; }
  }

  function write(level, args) {
    if (stopped || !ok) return;
    const text = Array.prototype.map.call(args, fmt).join(' ');
    try {
      fs.appendFileSync(file, stamp() + ' [' + level + '] ' + text + '\n');
      bytes += Buffer.byteLength(text, 'utf8') + 24;
      if (bytes > maxBytes) rotate();
    } catch (e) { broken = e; ok = false; }
  }

  // tee：先照常打屏幕，再落盘（顺序不能反，屏幕不能等磁盘）
  const wrap = (name) => function () { orig[name].apply(console, arguments); write(name, arguments); };
  console.log = wrap('log');
  console.info = wrap('info');
  console.warn = wrap('warn');
  console.error = wrap('error');

  // 崩溃前也留一条现场（同步写，写完了照旧崩，不吞掉异常语义）
  const onFatal = (e) => {
    write('fatal', [e]);
    process.removeListener('uncaughtException', onFatal);
    throw e;
  };
  process.on('uncaughtException', onFatal);

  const banner = o.banner || '工作台启动';
  if (ok) write('log', ['==== ' + banner + ' ====']);
  else orig.warn('[runlog] 运行日志写不进去（' + (broken && broken.message ? broken.message : '未知原因') + '）：只打屏幕，不影响跑分。');

  return {
    file,
    size: () => { try { return fs.statSync(file).size; } catch { return 0; } },
    note: () => (ok
      ? file + '（' + humanBytes(bytes) + '；含本次启动以来的终端输出）'
      : file + '（写不进去，本机没有拿到运行日志：' + (broken && broken.message) + '）'),
    stop: () => {
      if (stopped) return;
      write('log', ['（本次运行结束）']);
      stopped = true;
      console.log = orig.log;
      console.info = orig.info;
      console.warn = orig.warn;
      console.error = orig.error;
      process.removeListener('uncaughtException', onFatal);
    }
  };
}

module.exports = { start, MAX_BYTES, humanBytes, stamp };
