// Plan repair: proposals (api/_repair.js), schedule changes everywhere
// (penalty engine, context, planner, alarm cron) and the endpoint.
const R = require('../api/_repair.js');
const P = require('../api/_penalty.js');
const { anchorStatus } = require('../api/_context.js');
const { busyBlocks } = require('../api/_planner.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''));
const TODAY = '2026-11-30'; // Monday
const back = i => new Date(Date.parse(TODAY) - i * 864e5).toISOString().slice(0, 10);
const isSun = d => new Date(d + 'T12:00:00Z').getUTCDay() === 0;
const gymAt = (d, hm) => ({ anchor: 'gym', day: d, at: new Date(Date.parse(`${d}T${hm}:00+05:30`)).toISOString() });
const workdays = n => Array.from({ length: 20 }, (_, i) => back(i + 1)).filter(d => !isSun(d)).slice(0, n);

let raw = { checkins: workdays(6).map((d, i) => gymAt(d, i === 0 ? '09:25' : '10:10')) };
let p = R.proposals(raw, TODAY);
ok('1 gym late ~40 min on 5 of 6 days → propose 9:30 → 10:15', p.length === 1 && p[0].anchor === 'gym' && p[0].to_time === '10:15' && p[0].evidence.late_days === 5 && p[0].evidence.of_days === 6, p);
ok('2 proposal explains itself and says it applies from tomorrow', /5 of the last 6 days/.test(p[0].text) && /from tomorrow/.test(p[0].effect));
ok('3 only 2 late days → no proposal', R.proposals({ checkins: workdays(6).map((d, i) => gymAt(d, i < 2 ? '10:10' : '09:20')) }, TODAY).length === 0);
ok('4 always 3 hours late → too big to be a time shift, no proposal', R.proposals({ checkins: workdays(6).map(d => gymAt(d, '12:40')) }, TODAY).length === 0);
ok('5 5 min late → too small, no proposal', R.proposals({ checkins: workdays(6).map(d => gymAt(d, '09:35')) }, TODAY).length === 0);
ok('6 recovery days ignored', R.proposals(Object.assign({ marks: workdays(6).slice(1).map(d => ({ date: d, kind: 'recovery' })) }, raw), TODAY).length === 0);
ok('7 days without a check-in are unknown, not late', R.proposals({ checkins: workdays(2).map(d => gymAt(d, '10:10')) }, TODAY).length === 0);
const lunch = { logs: Array.from({ length: 7 }, (_, i) => ({ day: back(i + 1), entries_seen: { lunch: `${back(i + 1)}T${i < 4 ? '15:40' : '14:55'}:00+05:30` } })) };
ok('8 meals too: lunch logged ~40 min late → 15:00 → 15:45', R.proposals(lunch, TODAY).some(x => x.anchor === 'lunch' && x.to_time === '15:45'), R.proposals(lunch, TODAY));
const wake = { checkins: workdays(6).map(d => ({ anchor: 'wake', day: d, at: new Date(Date.parse(`${d}T08:40:00+05:30`)).toISOString() })) };
ok('9 wake / sleep never auto-shifted (health targets)', R.proposals(wake, TODAY).length === 0);
const rej = R.reject({}, p[0], '2026-11-29T10:00:00Z');
ok('10 rejected → not proposed again for 14 days', R.proposals(Object.assign({ schedule: rej }, raw), TODAY).length === 0);

// Approve → applies from tomorrow, everywhere
const sched = R.approve({}, p[0], TODAY, '2026-11-30T05:00:00Z');
ok('11 approve → override from tomorrow, with evidence', sched.overrides[0].anchor === 'gym' && sched.overrides[0].time === '10:15' && sched.overrides[0].from === '2026-12-01' && sched.overrides[0].was === '09:30');
ok('12 just changed → no new proposal for that anchor', R.proposals(Object.assign({ schedule: sched, scheduleOverrides: sched.overrides }, raw), TODAY).length === 0);
ok('13 anchorsOn: today still 9:30, tomorrow 10:15', P.anchorsOn(P.POLICY_V1.anchors, sched.overrides, TODAY).list.gym.time === '09:30' && P.anchorsOn(P.POLICY_V1.anchors, sched.overrides, '2026-12-01').list.gym.time === '10:15');
const policy = Object.assign({}, P.POLICY_V1, { effective_from: '2026-11-30T00:00:00+05:30', schedule_overrides: sched.overrides });
const cands = P.anchorCandidates({ policy, checkins: [gymAt('2026-11-30', '10:05'), gymAt('2026-12-01', '10:05')], logs: [], marks: [], now: Date.parse('2026-12-02T12:00:00+05:30') }).filter(c => c.key === 'gym');
ok('14 penalty engine: 10:05 is late today (old time) but on time tomorrow (new time)', cands.find(c => c.date === '2026-11-30').state !== 'ok' && cands.find(c => c.date === '2026-12-01').state === 'ok', cands.map(c => [c.date, c.state]));
const st = Object.fromEntries(anchorStatus({ checkins: [], logs: [], scheduleOverrides: sched.overrides }, Date.parse('2026-12-01T09:50:00+05:30')).map(a => [a.key, a]));
ok('15 context: tomorrow 9:50 gym is "upcoming" at 10:15', st.gym.state === 'upcoming' && st.gym.time === '10:15 AM', st.gym);
const busy = busyBlocks('2026-12-01', [], { AN: P.anchorsOn(P.POLICY_V1.anchors, sched.overrides, '2026-12-01') });
ok('16 planner: gym block starts at 10:15', new Date(busy.find(b => b.key === 'gym').from + 330 * 60000).toISOString().slice(11, 16) === '10:15');
const rv = R.revert(sched, 'gym', '2026-12-05', 'x');
ok('17 revert → back to 9:30 from the next day', P.anchorsOn(P.POLICY_V1.anchors, rv.overrides, '2026-12-06').list.gym.time === '09:30' && P.anchorsOn(P.POLICY_V1.anchors, rv.overrides, '2026-12-05').list.gym.time === '10:15');

(async () => {
  // Alarm cron: a moved-later anchor isn't due at the old cron time
  const nudge = require('path').join(__dirname, '../api/coach-nudge.js');
  process.env.ANTHROPIC_API_KEY = 'x';
  let sent = 0;
  global.fetch = async (url, init = {}) => { const u = decodeURIComponent(String(url)); const j = b => ({ ok: true, status: 200, json: async () => b });
    if (u.includes('api.anthropic.com')) { sent++; return j({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] }); }
    if (u.includes('jeetos_settings?id=eq.schedule')) return j([{ data: sched }]);
    return j([]); };
  delete require.cache[nudge];
  const h = require(nudge), RealNow = Date.now; Date.now = () => Date.parse('2026-12-01T09:40:00+05:30');
  const r = await new Promise(res => h({ headers: {}, query: { slot: 'anchor', anchor: 'gym' } }, { status: c => ({ json: b => res(b) }) }));
  Date.now = RealNow;
  ok('18 alarm cron at the old 9:40 time skips a gym moved to 10:15', /moved to 10:15/.test(r.skipped || '') && sent === 0, r);

  // Endpoint
  const osPath = require('path').join(__dirname, '../api/os.js');
  const store = { schedule: null }, decisions = [];
  global.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url)); const j = (b, st2 = 200) => ({ ok: st2 < 300, status: st2, json: async () => b });
    if (u.includes('rpc/jeetos_is_owner')) return j(true);
    if (u.includes('jeetos_settings') && init.method === 'POST') { store.schedule = JSON.parse(init.body).data; return j([{}], 201); }
    if (u.includes('jeetos_settings?id=eq.schedule')) return j(store.schedule ? [{ data: store.schedule }] : []);
    if (u.includes('jeetos_anchor_checkins')) return j(raw.checkins);
    if (u.includes('/jeetos_decisions') && init.method === 'POST') { decisions.push(JSON.parse(init.body)); return j(null, 201); }
    return j([]);
  };
  delete require.cache[osPath]; delete require.cache[require.resolve('../api/_auth.js')];
  const os = require(osPath), call = req => new Promise(res => os(Object.assign({ headers: { authorization: 'Bearer h.p.s' }, query: {} }, req), { status: c => ({ json: b => res({ code: c, body: b }) }) }));
  Date.now = () => Date.parse('2026-11-30T12:00:00+05:30');
  let x = await call({ method: 'GET', query: { action: 'repair' } });
  ok('19 GET repair → the gym proposal', x.code === 200 && x.body.proposals.length === 1 && x.body.proposals[0].id === 'shift:gym:10:15', x.body);
  x = await call({ method: 'POST', body: { action: 'repair.approve', id: 'shift:gym:11:00' } });
  ok('20 stale / made-up proposal id refused', x.code === 409);
  x = await call({ method: 'POST', body: { action: 'repair.approve', id: 'shift:gym:10:15' } });
  ok('21 approve → schedule saved from tomorrow + journal entry to review it', x.code === 200 && x.body.from === '2026-12-01' && store.schedule.overrides[0].time === '10:15' && decisions[0].source === 'repair' && decisions[0].status === 'approved' && /09:30 → 10:15/.test(decisions[0].change));
  x = await call({ method: 'GET', query: { action: 'repair' } });
  ok('22 after approval nothing else is proposed for gym', x.body.proposals.length === 0 && x.body.overrides.length === 1);
  x = await call({ method: 'POST', body: { action: 'repair.revert', anchor: 'gym' } });
  ok('23 revert saved', x.code === 200 && store.schedule.overrides.slice(-1)[0].revert === true);
  x = await call({ method: 'POST', body: { action: 'repair.revert', anchor: 'nope' } });
  ok('24 revert unknown anchor refused', x.code === 400);
  Date.now = RealNow;
})();
