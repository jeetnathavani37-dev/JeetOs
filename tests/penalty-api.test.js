const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 240) : ''));
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'; process.env.CRON_SECRET = 'cron';
// tiny in-memory PostgREST
const DB = { jeetos_penalty_policies: [], jeetos_penalty_incidents: [], jeetos_penalty_entries: [], jeetos_audit_events: [], jeetos_engine_lock: [{ id: 'penalty', locked_until: '1970-01-01T00:00:00Z' }],
  jeetos_commitments: [
    { id: 'c1', coach: 'fitness', text: 'Send deck', due: '2026-10-20', status: 'open', owner: 'jeet', staked: false },
    { id: 'c2', coach: 'sleep', text: 'Coach checks sleep', due: '2026-10-20', status: 'open', owner: 'coach', staked: false }],
  jeetos_logs: [] };
let seq = 1, keysUsed = new Set();
function filt(rows, qs) {
  return rows.filter(r => [...qs.entries()].every(([k, v]) => {
    if (['select', 'order', 'limit', 'on_conflict'].includes(k)) return true;
    const [op, ...rest] = v.split('.'); const val = rest.join('.');
    if (op === 'eq') return String(r[k]) === val; if (op === 'lt') return String(r[k]) < val; if (op === 'gte') return String(r[k]) >= val;
    if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').includes(String(r[k])); return true;
  }));
}
global.fetch = async (url, init = {}) => {
  const u = new URL(url), auth = init.headers && init.headers.Authorization;
  const j = (b, st = 200) => ({ ok: st < 300, status: st, json: async () => b, text: async () => JSON.stringify(b) });
  if (u.pathname.endsWith('rpc/jeetos_is_owner')) return j(auth === 'Bearer h.p.owner');
  keysUsed.add(auth);
  const t = u.pathname.split('/').pop(), rows = DB[t], qs = u.searchParams, m = init.method || 'GET';
  if (m === 'GET') return j(filt(rows, qs));
  if (m === 'PATCH') { const hit = filt(rows, qs); const b = JSON.parse(init.body); hit.forEach(r => Object.assign(r, b)); return j(hit); }
  if (m === 'POST') {
    const body = [].concat(JSON.parse(init.body)), pref = (init.headers && init.headers.Prefer) || '', conflict = qs.get('on_conflict'), out = [];
    for (const b of body) {
      const key = conflict ? conflict.split(',').map(k => b[k]).join('|') : null;
      const ex = key && rows.find(r => conflict.split(',').map(k => r[k]).join('|') === key);
      if (ex) { if (/merge-duplicates/.test(pref)) Object.assign(ex, b); continue; }
      const row = Object.assign({ id: b.id || seq++ }, b); rows.push(row); out.push(row);
    }
    return j(out, 201);
  }
  return j(null, 400);
};
const H = require('../api/penalty.js');
const call = (req) => new Promise(res => H(Object.assign({ headers: {}, query: {} }, req), { status: c => ({ json: b => res({ c, b }) }) }));
const owner = { authorization: 'Bearer h.p.owner' };
const RealNow = Date.now;
(async () => {
  Date.now = () => Date.parse('2026-10-19T10:00:00+05:30');
  let r = await call({ method: 'GET' });
  ok('cron without secret → 401', r.c === 401);
  r = await call({ method: 'POST', body: { action: 'run' } });
  ok('run without login → 401', r.c === 401);
  r = await call({ method: 'POST', headers: owner, body: { action: 'stake', commitment_id: 'c1' } });
  ok('stake before rules confirmed → refused', r.c === 409, r.b);
  r = await call({ method: 'POST', headers: owner, body: { action: 'confirm_policy', rules: { promise: { base_paise: 1 } } } });
  const pol = DB.jeetos_penalty_policies[0];
  ok('confirm → policy v1 active, client-sent rules ignored', r.c === 200 && pol.status === 'active' && pol.rules.promise.base_paise === 25000 && pol.mode === 'simulation', pol && pol.rules.promise);
  r = await call({ method: 'POST', headers: owner, body: { action: 'stake', commitment_id: 'c2' } });
  ok("can't stake a coach's own promise", r.c === 400);
  r = await call({ method: 'POST', headers: owner, body: { action: 'stake', commitment_id: 'c1', time: '23:00' } });
  const c1 = DB.jeetos_commitments[0];
  ok('stake → server sets agreed_at + deadline 23:00 IST', r.c === 200 && c1.staked && c1.deadline_at === '2026-10-20T17:30:00.000Z' && c1.agreed_at === '2026-10-19T04:30:00.000Z', c1);
  // 3 days later, still open
  Date.now = () => Date.parse('2026-10-23T09:00:00+05:30');
  r = await call({ method: 'GET', headers: { authorization: 'Bearer cron' } });
  const promiseEntries = DB.jeetos_penalty_entries.filter(e => e.incident_id === 'promise:c1').map(e => e.amount_paise);
  ok('cron run → ₹250, ₹500, ₹1,000 for the staked promise', JSON.stringify(promiseEntries) === '[25000,50000,100000]', promiseEntries);
  const logFines = DB.jeetos_penalty_entries.filter(e => /^log:/.test(e.incident_id));
  ok('no logs at all → ₹100 per missing entry, within day cap', logFines.length > 0 && logFines.every(e => e.amount_paise <= 10000), logFines.length);
  const byDay = {}; DB.jeetos_penalty_entries.forEach(e => { byDay[e.local_date] = (byDay[e.local_date] || 0) + e.amount_paise; });
  ok('day cap ₹1,000 respected on every day', Object.values(byDay).every(v => v <= 100000), byDay);
  const n = DB.jeetos_penalty_entries.length;
  r = await call({ method: 'GET', headers: { authorization: 'Bearer cron' } });
  ok('second cron run → no new entries', DB.jeetos_penalty_entries.length === n, r.b);
  ok('audit row per assessment', DB.jeetos_audit_events.filter(a => a.action === 'assessed').length === n);
  ok('lease released after run', DB.jeetos_engine_lock[0].locked_until === '1970-01-01T00:00:00Z');
  ok('engine wrote only with the server key', [...keysUsed].every(k => k === 'Bearer svc'), [...keysUsed]);
  r = await call({ method: 'POST', headers: owner, body: { action: 'unstake', commitment_id: 'c1' } });
  ok("can't unstake after 10 min", r.c === 409);
  Date.now = RealNow;
})();

// ── Manual UPI ₹1 test ──
(async () => {
  await new Promise(r => setTimeout(r, 50));
  DB.jeetos_payees = []; DB.jeetos_payments = [];
  const unique = DB.jeetos_payments;
  let r = await call({ method: 'POST', body: { action: 'pay_test_start' } });
  ok('pay: needs login', r.c === 401);
  r = await call({ method: 'POST', headers: owner, body: { action: 'pay_test_start' } });
  ok('pay: refused until a payee is saved', r.c === 409);
  r = await call({ method: 'POST', headers: owner, body: { action: 'set_payee', name: 'Charity', vpa: 'not a vpa', source_confirmed: true } });
  ok('payee: bad UPI ID rejected', r.c === 400);
  r = await call({ method: 'POST', headers: owner, body: { action: 'set_payee', name: 'Charity', vpa: 'donate@okbank' } });
  ok('payee: must confirm it came from the official site', r.c === 400);
  r = await call({ method: 'POST', headers: owner, body: { action: 'set_payee', name: 'Charity', vpa: 'donate@okbank', source_confirmed: true } });
  ok('payee saved', r.c === 200 && DB.jeetos_payees[0].vpa === 'donate@okbank');
  r = await call({ method: 'POST', headers: owner, body: { action: 'pay_test_start', amount_paise: 500000 } });
  const pay = r.b.payment;
  ok('test payment is always ₹1 (client amount ignored)', pay && pay.amount_paise === 100 && pay.status === 'initiated', pay);
  r = await call({ method: 'POST', headers: owner, body: { action: 'pay_test_start' } });
  ok('second start returns the same pending payment', r.b.payment.id === pay.id && DB.jeetos_payments.length === 1);
  r = await call({ method: 'POST', headers: owner, body: { action: 'pay_report', payment_id: pay.id, utr: '12345' } });
  ok('UTR must be 12 digits', r.c === 400);
  r = await call({ method: 'POST', headers: owner, body: { action: 'pay_report', payment_id: pay.id, utr: '4321 5678 9012' } });
  ok('reported paid with UTR (self-reported)', r.c === 200 && DB.jeetos_payments[0].status === 'reported_paid' && DB.jeetos_payments[0].utr === '432156789012');
  r = await call({ method: 'POST', headers: owner, body: { action: 'pay_report', payment_id: pay.id, utr: '432156789012' } });
  ok('cannot report the same payment twice', r.c === 409);
  ok('audit says self-reported', DB.jeetos_audit_events.some(a => a.action === 'reported_paid' && /self-reported/.test(a.detail.verification)));
})();

// ── Going live + weekly settlement ──
(async () => {
  await new Promise(r => setTimeout(r, 300));
  DB.jeetos_coach_inbox = []; DB.jeetos_push_subs = [];
  DB.jeetos_payees = [{ id: 'charity', name: 'Akshaya Patra Foundation', vpa: 'Akshayapatra@kotak' }];
  DB.jeetos_payments = [];
  const simEntries = DB.jeetos_penalty_entries.length;
  let r = await call({ method: 'POST', headers: owner, body: { action: 'dues' } });
  ok('live: simulation fines are not owed', r.b.live === false && r.b.dues_paise === 0 && simEntries > 0);
  r = await call({ method: 'POST', headers: owner, body: { action: 'go_live' } });
  ok('live: refused without typing LIVE', r.c === 400);
  Date.now = () => Date.parse('2026-10-24T10:00:00+05:30');
  r = await call({ method: 'POST', headers: owner, body: { action: 'go_live', confirm: 'LIVE' } });
  const v = DB.jeetos_penalty_policies;
  ok('live: new version active in live mode, old retired', r.c === 200 && v.find(p => p.version === 1).status === 'retired' && v.find(p => p.version === 2).mode === 'live' && v.find(p => p.version === 2).status === 'active', v.map(p => [p.version, p.mode, p.status]));
  DB.jeetos_commitments.push({ id: 'c9', coach: 'fitness', text: 'Meal prep', due: '2026-10-24', status: 'open', owner: 'jeet', staked: false });
  r = await call({ method: 'POST', headers: owner, body: { action: 'stake', commitment_id: 'c9', time: '23:00' } });
  ok('live: staking under the live policy', r.c === 200 && DB.jeetos_commitments.find(c => c.id === 'c9').policy_version === 2);
  // all of 25 Oct's logs present so only the promise counts
  DB.jeetos_logs = [{ day: '2026-10-24', entries: {}, entries_seen: { breakfast: '2026-10-24T09:00:00+05:30', lunch: '2026-10-24T13:00:00+05:30', dinner: '2026-10-24T21:00:00+05:30', sleep: '2026-10-24T08:00:00+05:30' } },
                   { day: '2026-10-25', entries: {}, entries_seen: { breakfast: '2026-10-25T09:00:00+05:30', lunch: '2026-10-25T13:00:00+05:30', sleep: '2026-10-25T08:00:00+05:30' } }];
  Date.now = () => Date.parse('2026-10-25T18:30:00+05:30'); // Sunday evening
  r = await call({ method: 'GET', headers: { authorization: 'Bearer cron' } });
  r = await call({ method: 'POST', headers: owner, body: { action: 'dues' } });
  ok('live: missed live promise → ₹250 owed', r.b.live && r.b.dues_paise === 25000, r.b);
  ok('live: Sunday settle-up notice sent once', DB.jeetos_coach_inbox.length === 1 && /₹250/.test(DB.jeetos_coach_inbox[0].text));
  await call({ method: 'GET', headers: { authorization: 'Bearer cron' } });
  ok('live: second Sunday run → no second notice', DB.jeetos_coach_inbox.length === 1);
  r = await call({ method: 'POST', headers: owner, body: { action: 'settle_start', amount_paise: 1 } });
  const pay = r.b.payment;
  ok('settle: payment = server-computed dues (₹250) to Akshaya Patra', pay && pay.kind === 'settlement' && pay.amount_paise === 25000 && pay.payee_vpa === 'Akshayapatra@kotak', pay);
  r = await call({ method: 'POST', headers: owner, body: { action: 'pay_report', payment_id: pay.id, utr: '111122223333' } });
  r = await call({ method: 'POST', headers: owner, body: { action: 'dues' } });
  ok('settle: after paying, nothing owed', r.b.dues_paise === 0 && r.b.paid_paise === 25000, r.b);
  r = await call({ method: 'POST', headers: owner, body: { action: 'settle_start' } });
  ok('settle: nothing to pay → refused', r.c === 409);
})();
