// Find submission IDs that have real, viewable pages.
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36' };

const api = async (m, q = '') => {
  const r = await fetch(`https://codeforces.com/api/${m}?${q}`, { headers: H });
  return r.json();
};

const st = await api('user.status', 'handle=tourist&from=1&count=8');
console.log('--- tourist recent submissions (API) ---');
for (const s of st.result) {
  console.log(`${s.id}  contest=${s.contestId}  ${s.problem.index} ${s.problem.name}  ${s.verdict}  ${s.programmingLanguage}`);
}

// contest.status for a big recent contest
const cs = await api('contest.status', 'contestId=2261&from=1&count=5');
console.log('\n--- contest 2261 status (API) ---');
if (cs.status === 'OK') for (const s of cs.result.slice(0, 5)) {
  console.log(`${s.id}  ${s.problem.index}  ${s.author.members[0].handle}  ${s.verdict}  ${s.programmingLanguage}`);
} else console.log(JSON.stringify(cs));

console.log('\n--- contest.list sample fields ---');
const cl = await api('contest.list', 'gym=false');
console.log(JSON.stringify(cl.result[0], null, 1));

console.log('\n--- user.rating sample fields ---');
const ur = await api('user.rating', 'handle=tourist');
console.log(JSON.stringify(ur.result[0], null, 1));
