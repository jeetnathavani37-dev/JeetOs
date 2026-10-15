// Patterns (api/_insights.js) and the decision journal (api/os.js).
const I = require('../api/_insights.js');
const { buildPacket } = require('../api/_context.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''));
const TODAY = '2026-11-30'; // Monday
const back = i => new Date(Date.parse(TODAY) - i * 864e5).toISOString().slice(0, 10);
const D = n => Array.from({ length: n }, (_, i) => back(i + 1));
const isSun = d => new Date(d + 'T12:00:00Z').getUTCDay() === 0;

let rep = I.insightReport({}, TODAY);
ok('1 no data → no insights, everything "waiting"', rep.insights.length === 0 && rep.waiting.length >= 3);

// Late nights → gym skipped next day; good nights → gym done.
const logs = D(30).map((d, i) => ({ day: d, sleep_hours: i % 2 ? 7.5 : 5, bedtime: i % 2 ? '00:10' : '02:00', gym_done: !isSun(d) && i % 2 === 1, total_cal: 2000 }));
rep = I.insightReport({ logs }, TODAY);
const sg = rep.insights.find(x => x.id === 'sleep_gym');
ok('2 sleep→gym pattern found with sample sizes', sg && sg.rate['good-sleep'] === 100 && sg.rate['late/short-sleep'] === 0 && sg.n['good-sleep'] >= 4 && sg.n['late/short-sleep'] >= 4, sg);
ok('3 phrased as a comparison with n, not a cause', /Gym next day: 100% after good-sleep days \(n=\d+\) vs 0% after late\/short-sleep days/.test(sg.text));

// Only 3 days of data → not enough
rep = I.insightReport({ logs: logs.slice(0, 3) }, TODAY);
ok('4 too few days → "not enough data", no claim', !rep.insights.some(x => x.id === 'sleep_gym') && rep.waiting.some(x => x.id === 'sleep_gym' && /not enough data/.test(x.text)));

// No real difference → reported as steady, not an insight
const flat = D(30).map((d, i) => ({ day: d, sleep_hours: i % 2 ? 7 : 5, gym_done: !isSun(d) && i % 4 < 2 }));
rep = I.insightReport({ logs: flat }, TODAY);
ok('5 small difference → not called a pattern', !rep.insights.some(x => x.id === 'sleep_gym') && rep.steady.some(x => x.id === 'sleep_gym'), rep.steady.map(x => x.text));

// Recovery days are left out
const sick = { logs, marks: D(30).map(d => ({ date: d, kind: 'recovery' })) };
ok('6 recovery days excluded from every comparison', I.insightReport(sick, TODAY).insights.length === 0);

// Late wake → gym
const checkins = D(30).filter(d => !isSun(d)).flatMap((d, i) => [{ anchor: 'wake', day: d, at: `${d}T${i % 2 ? '02:15' : '04:00'}:00Z` }].concat(i % 2 ? [{ anchor: 'gym', day: d }] : []));
rep = I.insightReport({ checkins }, TODAY);
ok('7 late wake → gym pattern', rep.insights.some(x => x.id === 'wake_gym' && x.rate['on-time-wake'] === 100 && x.rate['late-wake'] === 0));

// Energy → plan done
const dc = D(12).flatMap((d, i) => [{ day: d, kind: 'morning', answers: { energy: i % 2 ? 4 : 1 } }, { day: d, kind: 'evening', answers: { done: i % 2 ? ['a', 'b', 'c'] : ['a'], not_done: i % 2 ? [] : ['b', 'c'] } }]);
rep = I.insightReport({ dailyCheckins: dc }, TODAY);
ok('8 morning energy → plan completion pattern', rep.insights.some(x => x.id === 'energy_done' && x.rate['energy-3+'] === 100 && x.rate['energy-1-2'] === 0));

// Weekdays
const wk = D(28).map(d => { const dow = new Date(d + 'T12:00:00Z').getUTCDay(); return { day: d, total_cal: dow === 6 ? 3000 : 1900, sleep_hours: dow === 6 ? 4 : 7 }; });
rep = I.insightReport({ logs: wk }, TODAY);
const wd = rep.insights.find(x => x.id === 'weekday');
ok('9 weekday pattern names the worst day with n', wd && /worst Saturday 0% \(n=4\)/.test(wd.text), wd && wd.text);

// Intervention before/after
const dec = [{ id: 'd1', area: 'diet', change: 'Dinner by 11 PM', status: 'approved', decided_at: back(14) + 'T10:00:00Z' }];
const iv = D(28).map((d, i) => ({ day: d, total_cal: i < 14 ? 1900 : 2600 }));
rep = I.insightReport({ logs: iv, decisions: dec }, TODAY);
const di = rep.insights.find(x => x.id === 'decision:d1');
ok('10 plan change: diet 14 days after vs before', di && di.rate.after === 100 && di.rate.before === 0 && /"Dinner by 11 PM"/.test(di.text), di);

// Packet
const pk = buildPacket({ logs, decisions: [{ id: 'd2', change: 'Gym at 7 PM', decided_at: back(20) + 'T00:00:00Z', status: 'approved', expected_outcome: '5 gym days a week' }] }, { coach: 'fitness', now: Date.parse('2026-11-30T10:00:00+05:30') });
ok('11 packet: patterns with n + "correlation, never cause"', /\[PATTERNS IN HIS DATA/.test(pk.text) && /Gym next day: 100% after good-sleep/.test(pk.text) && /pattern, not proof of cause/.test(pk.text));
ok('12 packet: decision due for review (14 days after approval)', /DECISIONS DUE FOR REVIEW/.test(pk.text) && /"Gym at 7 PM" \(decided .*expected: 5 gym days a week/.test(pk.text));

// Journal endpoint
(async () => {
  const osPath = require('path').join(__dirname, '../api/os.js');
  const rows = [];
  global.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url)); const j = (b, st = 200) => ({ ok: st < 300, status: st, json: async () => b });
    if (u.includes('rpc/jeetos_is_owner')) return j(true);
    if (u.includes('/jeetos_decisions')) {
      if (init.method === 'POST') { const r = JSON.parse(init.body); rows.push(r); return j([r], 201); }
      const id = /id=eq\.([a-z0-9]+)/i.exec(u);
      if (init.method === 'PATCH') { const hit = rows.filter(r => r.id === id[1]); hit.forEach(r => Object.assign(r, JSON.parse(init.body))); return j(hit); }
      return j(id ? rows.filter(r => r.id === id[1]) : rows);
    }
    return j([]);
  };
  delete require.cache[osPath]; delete require.cache[require.resolve('../api/_auth.js')];
  const h = require(osPath);
  const call = req => new Promise(res => h(Object.assign({ headers: { authorization: 'Bearer h.p.s' }, query: {} }, req), { status: c => ({ json: b => res({ code: c, body: b }) }) }));
  const inWeek = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  let x = await call({ method: 'POST', body: { action: 'journal.add', change: 'Switch gym to evenings during exams', alternatives: 'Skip gym; home workouts', expected: '5 gym days/week', review_on: inWeek, area: 'fitness' } });
  ok('13 add a decision with alternatives, expectation and review date', x.code === 200 && rows[0].coach === 'jeet' && rows[0].status === 'approved' && rows[0].alternatives === 'Skip gym; home workouts' && rows[0].review_on === inWeek);
  x = await call({ method: 'POST', body: { action: 'journal.add', change: 'x' } });
  ok('14 empty decision refused', x.code === 400);
  x = await call({ method: 'POST', body: { action: 'journal.add', change: 'Something real', review_on: '2020-01-01' } });
  ok('15 review date in the past refused', x.code === 400);
  x = await call({ method: 'GET', query: { action: 'journal' } });
  ok('16 journal lists it, not yet due', x.body.decisions.length === 1 && x.body.decisions[0].due === false);
  rows[0].review_on = '2020-01-01';
  x = await call({ method: 'GET', query: { action: 'journal' } });
  ok('17 past review date → due', x.body.decisions[0].due === true);
  x = await call({ method: 'POST', body: { action: 'journal.outcome', id: rows[0].id, verdict: 'worked', actual: '6 gym days' } });
  ok('18 record the outcome', x.code === 200 && rows[0].verdict === 'worked' && rows[0].actual_outcome === '6 gym days' && rows[0].outcome_at);
  x = await call({ method: 'POST', body: { action: 'journal.outcome', id: rows[0].id, verdict: 'great' } });
  ok('19 invalid verdict refused', x.code === 400);
})();
