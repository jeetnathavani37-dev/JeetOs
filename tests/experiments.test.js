// Personal experiments (api/_experiments.js): frozen baseline, pre-registered bar,
// code gives the verdict, unknown ≠ fail, one at a time.
const X = require('../api/_experiments.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''));
const add = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const START = '2026-11-15', NOW = '2026-11-15T10:00:00Z';
const before = Array.from({ length: 14 }, (_, i) => add(START, -14 + i));
const logs = before.map((d, i) => ({ day: d, sleep_hours: i % 2 ? 6 : 6.5, total_cal: 2300 }));
const raw = { logs, marks: [], checkins: [], dailyCheckins: [] };
const input = { metric: 'sleep_hours', direction: 'up', min_change: 0.5, days: 14, action: 'Phone charger outside the bedroom' };

let s = X.start(input, raw, START, null, NOW);
ok('1 start freezes the baseline from the 14 days before', s.row && s.row.base_stats.n === 14 && s.row.base_stats.mean === 6.25 && s.row.base_from === '2026-11-01' && s.row.base_to === '2026-11-14', s.row && s.row.base_stats);
ok('2 test window and review date fixed up front', s.row.test_from === START && s.row.test_to === '2026-11-28' && s.row.review_date === '2026-11-29' && s.row.status === 'active' && s.row.kind === 'measured');
ok('3 criterion written in plain words', s.row.criterion === '+0.5 h vs baseline' && s.row.baseline === '6.25 h', [s.row.criterion, s.row.baseline]);
ok('4 only one at a time', /one experiment at a time/.test(X.start(input, raw, START, { id: 'x' }, NOW).error));
ok('5 bar must be in range for the metric', /0.25–3/.test(X.start(Object.assign({}, input, { min_change: 5 }), raw, START, null, NOW).error));
ok('6 length 7–28 days', /7–28/.test(X.start(Object.assign({}, input, { days: 60 }), raw, START, null, NOW).error));
ok('7 not enough baseline data → refused (with how much is missing)', /3 of 14 days, need 7/.test(X.start(input, { logs: logs.slice(0, 3) }, START, null, NOW).error));
ok('8 unknown metric refused', !!X.start(Object.assign({}, input, { metric: 'iq' }), raw, START, null, NOW).error);
ok('9 html stripped from the action', X.start(Object.assign({}, input, { action: '<b>No phone</b> in bed' }), raw, START, null, NOW).row.action === 'No phone in bed');

const e = s.row;
const during = Array.from({ length: 14 }, (_, i) => add(START, i));
const withTest = (vals) => Object.assign({}, raw, { logs: logs.concat(during.map((d, i) => vals[i] == null ? null : { day: d, sleep_hours: vals[i] }).filter(Boolean)) });

let v = X.evaluate(e, withTest(Array(14).fill(7)), '2026-11-20');
ok('10 mid-way: progress only, no verdict', v.verdict === null && v.final === false && v.test.n === 5 && v.days_left === 9, v);
v = X.evaluate(e, withTest(Array(14).fill(7)), '2026-11-29');
ok('11 at the end: +0.75 h ≥ 0.5 → worked', v.verdict === 'worked' && v.delta === 0.75 && /6.25 h → 7 h/.test(v.text) && /not proof/.test(v.text), v.text);
v = X.evaluate(e, withTest(Array(14).fill(6.5)), '2026-11-29');
ok('12 +0.25 h < 0.5 bar → didn\'t (smaller than the bar)', v.verdict === 'didnt' && /Smaller than the bar/.test(v.text), v.text);
v = X.evaluate(e, withTest(Array(14).fill(5.5)), '2026-11-29');
ok('13 got worse → didn\'t, "No improvement"', v.verdict === 'didnt' && /No improvement/.test(v.text));
v = X.evaluate(e, withTest([7, 7, 7, null, null, null, null, null, null, null, null, null, null, null]), '2026-11-29');
ok('14 too few test days → unclear, missing days not fails', v.verdict === 'unclear' && v.test.n === 3 && v.test.no_data === 11, v.text);
const sick = Object.assign(withTest(Array(14).fill(7)), { marks: during.slice(0, 10).map(d => ({ date: d, kind: 'recovery' })) });
v = X.evaluate(e, sick, '2026-11-29');
ok('15 recovery days left out (not counted either way)', v.test.excused === 10 && v.verdict === 'unclear', v.test);

// down-direction + rate metric
const dl = Array.from({ length: 14 }, (_, i) => add(START, -14 + i)).map((d, i) => ({ day: d, total_cal: i < 7 ? 2600 : 1900, junk_meals: 0 }));
const d0 = X.start({ metric: 'kcal', direction: 'down', min_change: 200, days: 14, action: 'Meal prep Sunday' }, { logs: dl }, START, null, NOW).row;
v = X.evaluate(d0, { logs: dl.concat(during.map(d => ({ day: d, total_cal: 1900 }))) }, '2026-11-29');
ok('16 direction "down": 2250 → 1900 kcal (−350) ≥ 200 → worked', d0.base_stats.mean === 2250 && v.verdict === 'worked' && v.delta === -350, v.text);
const r0 = X.start({ metric: 'diet', direction: 'up', min_change: 20, days: 14, action: 'No junk at home' }, { logs: dl }, START, null, NOW).row;
ok('17 rate metric baseline in % of days', r0.base_stats.mean === 50 && r0.baseline === '50%', r0.base_stats);
v = X.evaluate(r0, { logs: dl.concat(during.map(d => ({ day: d, total_cal: 1900, junk_meals: 0 }))) }, '2026-11-29');
ok('18 50% → 100% days (+50 points) → worked', v.verdict === 'worked' && v.delta === 50 && /points/.test(v.text), v.text);
const g0 = X.start({ metric: 'gym', direction: 'up', min_change: 10, days: 7, action: 'Gym bag packed at night' }, { logs: before.map(d => ({ day: d, gym_done: true })) }, START, null, NOW).row;
ok('19 gym counts Mon–Sat only (Sunday not in the window)', g0.base_stats.days === 6, g0.base_stats);
const en = X.start({ metric: 'energy', direction: 'up', min_change: 0.5, days: 7, action: 'Walk after lunch' }, { logs: [], dailyCheckins: before.slice(7).map(d => ({ day: d, kind: 'morning', answers: { energy: 3 } })) }, START, null, NOW).row;
ok('20 energy read from morning check-ins when the log has none', en && en.base_stats.mean === 3 && en.base_stats.n === 7, en && en.base_stats);

const p = X.finalPatch(X.evaluate(e, withTest(Array(14).fill(7)), '2026-11-29'), NOW);
ok('21 final patch: worked → "worked", text in outcome, full result kept', p.status === 'worked' && /worked/.test(p.outcome) && p.result.verdict === 'worked' && p.decided_at === NOW);
ok('22 didn\'t → stored as "failed" (matches the coaches\' count)', X.finalPatch({ verdict: 'didnt', text: 'x' }, NOW).status === 'failed');

(async () => {
  // Endpoint: start → progress → auto-finish when due → one at a time; unreadable data → no verdict.
  const osPath = require('path').join(__dirname, '../api/os.js');
  const rows = []; let failLogs = false;
  const allLogs = logs.concat(during.map(d => ({ day: d, sleep_hours: 7 })));
  global.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url)); const j = (b, st = 200) => ({ ok: st < 300, status: st, json: async () => b });
    if (u.includes('rpc/jeetos_is_owner')) return j(true);
    if (u.includes('/jeetos_logs')) { if (failLogs) return j({ message: 'denied' }, 401); const m = /day=gte\.([\d-]+)&day=lte\.([\d-]+)/.exec(u); return j(allLogs.filter(l => l.day >= m[1] && l.day <= m[2])); }
    if (u.includes('/jeetos_experiments') && init.method === 'POST') { const r = JSON.parse(init.body); if (rows.some(x => x.status === 'active')) return j({ code: '23505' }, 409); rows.push(r); return j([r], 201); }
    if (u.includes('/jeetos_experiments') && init.method === 'PATCH') { const id = /id=eq\.([^&]+)/.exec(u)[1], r = rows.find(x => x.id === id && x.status === 'active'); if (!r) return j([]); Object.assign(r, JSON.parse(init.body)); return j([r]); }
    if (u.includes('/jeetos_experiments')) return j(rows.slice().reverse());
    return j([]);
  };
  delete require.cache[osPath]; delete require.cache[require.resolve('../api/_auth.js')];
  const os = require(osPath), call = req => new Promise(res => os(Object.assign({ headers: { authorization: 'Bearer h.p.s' }, query: {} }, req), { status: c => ({ json: b => res({ code: c, body: b }) }) }));
  const RealNow = Date.now;
  Date.now = () => Date.parse('2026-11-15T12:00:00+05:30');
  let x = await call({ method: 'POST', body: { action: 'experiment.start', metric: 'sleep_hours', direction: 'up', min_change: 0.5, days: 14, action_text: 'Charger outside the room' } });
  ok('23 POST start → stored active with frozen baseline', x.code === 200 && rows[0].status === 'active' && rows[0].base_stats.mean === 6.25 && rows[0].action === 'Charger outside the room', x.body);
  x = await call({ method: 'POST', body: { action: 'experiment.start', metric: 'kcal', direction: 'down', min_change: 100, days: 7, action_text: 'Second one' } });
  ok('24 a second one is refused while one is active', x.code === 400 && /one experiment at a time/.test(x.body.error));
  Date.now = () => Date.parse('2026-11-20T12:00:00+05:30');
  x = await call({ method: 'GET', query: { action: 'experiments' } });
  ok('25 GET mid-way → progress, no verdict, metrics listed', x.code === 200 && x.body.active && x.body.progress.verdict === null && x.body.metrics.sleep_hours.unit === 'h', x.body.progress);
  failLogs = true; Date.now = () => Date.parse('2026-11-30T12:00:00+05:30');
  x = await call({ method: 'GET', query: { action: 'experiments' } });
  ok('26 data unreadable at the end → error, experiment NOT judged', x.code === 502 && rows[0].status === 'active', x.body);
  failLogs = false;
  x = await call({ method: 'GET', query: { action: 'experiments' } });
  ok('27 after the end → verdict saved by code (worked) and moved to past', x.code === 200 && x.body.active === null && rows[0].status === 'worked' && rows[0].result.delta === 0.75 && x.body.past.length === 1, rows[0].outcome);
  x = await call({ method: 'POST', body: { action: 'experiment.start', metric: 'sleep_hours', direction: 'up', min_change: 0.25, days: 7, action_text: 'Read before bed' } });
  ok('28 after finishing, a new one can start', x.code === 200 && rows[1].status === 'active');
  x = await call({ method: 'POST', body: { action: 'experiment.stop', id: 'nope' } });
  ok('29 stop needs the active id', x.code === 404);
  x = await call({ method: 'POST', body: { action: 'experiment.stop', id: rows[1].id } });
  ok('30 stop → "stopped", no verdict', x.code === 200 && rows[1].status === 'stopped' && /no verdict/.test(rows[1].outcome));
  Date.now = RealNow;
})();
{
  const C = require('../api/_context.js');
  const pk = C.buildPacket({ experiments: [{ action: 'Charger bahar', target: 'Sleep hours', baseline: '6.25 h', criterion: '+0.5 h vs baseline', test_to: '2026-12-12' }] }, { coach: 'sleep', now: Date.parse('2026-11-20T10:00:00+05:30') });
  ok('31 coaches see the running experiment and are told not to judge it early', /HIS EXPERIMENT RUNNING .*don't judge it early/.test(pk.text) && /"Charger bahar" — Sleep hours: before 6.25 h; worked = \+0.5 h vs baseline; ends 2026-12-12/.test(pk.text));
}
