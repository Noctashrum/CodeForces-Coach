// Diagnose redirect chain for codeforces URLs from inside real Chromium.
import fs from 'node:fs';
const port = process.argv[2] || '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 60000);
  });
  return { send, ws };
}

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const c = await cdpConnect(page.webSocketDebuggerUrl);
await c.send('Page.enable'); await c.send('Runtime.enable');

const ev = async (expr) => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

// Ensure CF challenge is passed first
await c.send('Page.navigate', { url: 'https://codeforces.com/' });
for (let i = 0; i < 40; i++) {
  await sleep(2000);
  const t = await ev('document.title').catch(() => '');
  if (t && !/请稍候|just a moment/i.test(t)) break;
}
console.log('CF warm-up done, title =', await ev('document.title'));

const urls = [
  'https://codeforces.com/contest/4/submission/392102836',
  'https://codeforces.com/problemset/submission/4/392102836',
  'https://codeforces.com/submissions/tourist',
  'https://codeforces.com/contest/4/my',
  'https://codeforces.com/problemset/status/4/problem/A',
];
const out = {};
for (const u of urls) {
  const r = await ev(`(async()=>{
    try{
      const resp = await fetch(${JSON.stringify(u)}, {redirect:'follow', credentials:'include'});
      const txt = await resp.text();
      return JSON.stringify({url:resp.url, status:resp.status, redirected:resp.redirected, len:txt.length,
        hasPre: txt.includes('program-source-text'),
        title: (txt.match(/<title>([\\s\\S]*?)<\\/title>/)||[])[1]||'',
        srcNA: /Source:\\s*<[^>]*>\\s*N\\/A|not available/i.test(txt)});
    }catch(e){ return JSON.stringify({err:String(e)}); }
  })()`);
  console.log(u, '\n   ->', r);
  out[u] = r;
}
fs.writeFileSync(process.env.TEMP + '\\cf_diag.json', JSON.stringify(out, null, 2));
c.ws.close();
