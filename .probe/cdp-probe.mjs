// CDP probe: drive real Chromium, check if Codeforces HTML passes Cloudflare.
// Usage: node cdp-probe.mjs <cdpPort> <url> [outFile]
import fs from 'node:fs';

const port = process.argv[2] || '9333';
const target = process.argv[3] || 'https://codeforces.com/contest/4/submission/100000';
const out = process.argv[4] || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets() {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
    const c = new Cdp(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 40000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  let pageWs = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await cdpTargets();
      const page = list.find((t) => t.type === 'page');
      if (page) { pageWs = page.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(500);
  }
  if (!pageWs) { console.log('RESULT: could not reach CDP endpoint'); process.exit(2); }

  const c = await Cdp.connect(pageWs);
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  // Navigate
  await c.send('Page.navigate', { url: target });

  const deadline = Date.now() + 60000;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(2000);
    let title = '', ready = '', href = '', hasPre = false, bodyLen = 0;
    try {
      title = await c.eval('document.title');
      ready = await c.eval('document.readyState');
      href = await c.eval('location.href');
      hasPre = await c.eval('!!document.getElementById("program-source-text")');
      bodyLen = await c.eval('document.body ? document.body.innerHTML.length : 0');
    } catch {}
    const elapsed = Math.round((60000 - (deadline - Date.now())) / 1000);
    const line = 't+' + elapsed + 's title=' + JSON.stringify(title) + ' ready=' + ready + ' pre=' + hasPre + ' body=' + bodyLen;
    if (line.slice(0, 60) !== last.slice(0, 60)) { console.log(line); last = line; }
    const cfChallenge = /just a moment|请稍候|attention required|checking your browser/i.test(title);
    if (!cfChallenge && ready === 'complete' && bodyLen > 5000) break;
  }

  const finalTitle = await c.eval('document.title');
  const html = await c.eval('document.documentElement.outerHTML');
  console.log('FINAL title:', finalTitle);
  console.log('FINAL html bytes:', html.length);
  const hasPre = await c.eval('!!document.getElementById("program-source-text")');
  console.log('has #program-source-text:', hasPre);
  if (hasPre) {
    const src = await c.eval('document.getElementById("program-source-text").textContent');
    console.log('SOURCE (first 400 chars):');
    console.log(src.slice(0, 400));
  }
  if (out) fs.writeFileSync(out, html, 'utf8');
  c.close();
}

main().catch((e) => { console.log('PROBE ERROR:', e.message); process.exit(1); });
