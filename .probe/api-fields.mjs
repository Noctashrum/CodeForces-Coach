// Full API field enumeration — writes to .probe/api-fields.txt
import fs from 'node:fs';
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36' };
const log = [];
const P = (s) => { log.push(s); console.log(s); };

const api = async (m, q = '') => {
  const url = `https://codeforces.com/api/${m}?${q}`;
  const r = await fetch(url, { headers: H });
  const t = await r.text();
  P(`\n=== ${m}  [HTTP ${r.status}]  ${url}`);
  try { return JSON.parse(t); } catch { P('  non-JSON: ' + t.slice(0, 200)); return null; }
};

const keys = (o) => Object.keys(o).join(', ');

// 1. user.status
const st = await api('user.status', 'handle=tourist&from=1&count=2');
if (st) {
  P('  submission keys: ' + keys(st.result[0]));
  P('  problem keys   : ' + keys(st.result[0].problem));
  P('  author keys    : ' + keys(st.result[0].author));
  P('  members[0] keys: ' + keys(st.result[0].author.members[0]));
  P('  SAMPLE: ' + JSON.stringify(st.result[0]));
  // look for any source-ish field anywhere
  const flat = JSON.stringify(st.result[0]).toLowerCase();
  for (const k of ['source', 'code', 'solution', 'program"']) {
    P(`  contains "${k}"? ${flat.includes(k)}`);
  }
}

// 2. contest.status
const cs = await api('contest.status', 'contestId=2261&from=1&count=2');
if (cs && cs.status === 'OK') {
  P('  submission keys: ' + keys(cs.result[0]));
  P('  has source field? ' + ('source' in cs.result[0]));
  P('  SAMPLE: ' + JSON.stringify(cs.result[0]));
} else if (cs) P('  ' + JSON.stringify(cs));

// 3. contest.standings — try with proper params
for (const q of ['contestId=2261&from=1&count=2', 'contestId=2261&from=1&count=2&showUnofficial=true', 'contestId=2261&handles=tourist']) {
  const r = await api('contest.standings', q);
  if (r && r.status === 'OK') {
    P('  result keys: ' + keys(r.result));
    P('  contest keys: ' + keys(r.result.contest));
    P('  problems[0] keys: ' + keys(r.result.problems[0]));
    P('  rows[0] keys: ' + keys(r.result.rows[0]));
    P('  rows[0].problemResults[0] keys: ' + keys(r.result.rows[0].problemResults[0]));
    P('  rows[0].party keys: ' + keys(r.result.rows[0].party));
    P('  SAMPLE row: ' + JSON.stringify(r.result.rows[0]).slice(0, 900));
    break;
  } else if (r) P('  ' + JSON.stringify(r));
}

// 4. user.rating
const ur = await api('user.rating', 'handle=tourist');
if (ur) {
  P('  rating change keys: ' + keys(ur.result[0]));
  P('  SAMPLE: ' + JSON.stringify(ur.result[0]));
}

// 5. contest.list
const cl = await api('contest.list', 'gym=false');
if (cl) {
  P('  contest keys: ' + keys(cl.result[0]));
  P('  SAMPLE: ' + JSON.stringify(cl.result[0]));
}

// 6. contest.list gym=true (gym contests)
const cg = await api('contest.list', 'gym=true');
if (cg && cg.status === 'OK') P('  gym sample: ' + JSON.stringify(cg.result[0]));

// 7. other endpoints existence probes
for (const [m, q] of [['user.info', 'handles=tourist'], ['problemset.problems', ''], ['contest.hacks', 'contestId=2261']]) {
  const r = await api(m, q);
  if (r && r.status === 'OK') P(`  ${m} OK, result type=${Array.isArray(r.result) ? 'array' : typeof r.result}`);
}

fs.writeFileSync(new URL('./api-fields.txt', import.meta.url), log.join('\n'), 'utf8');
