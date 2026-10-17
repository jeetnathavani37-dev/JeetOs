// What-if simulator (api/_whatif.js + POST /api/os whatif): his own data, ranges not one date,
// assumptions listed, unknown when the data can't support an answer, nothing saved.
const W = require('../api/_whatif.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 320) : ''));
const TODAY = '2026-11-29';
const add = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const days = Array.from({ length: 28 }, (_, i) => add(TODAY, -28 + i));       // 11-01 … 11-28
// He ate 2,200 a day and lost 0.5 kg/week (90.0 → 88.5 over 3 weeks between window centres).
const logs = days.map(d => ({ day: d, total_cal: 2200 }));
const wi = (d, kg) => ({ id: d, day: d, kg, fasted: true, morning: true, measured_at: d + 'T02:00:00Z' });
const weighins = [wi(days[1], 90.0), wi(days[4], 90.0), wi(days[22], 88.5), wi(days[26], 88.5)];
const checkins = days.filter((d, i) => i % 7 < 3).map(d => ({ anchor: 'gym', day: d }));   // ~3×/week
const raw = { logs, weighins, checkins, weightGoal: { baseline_kg: 90, target_loss_kg: 10, end_day: '2027-02-20' } };

const m = W.maintenanceFromData(raw, TODAY);
ok('1 maintenance from his own logs + trend: 2200 + 1.5 kg × 7700 / 21 ≈ 2750', m.kcal === 2750 && m.range[0] === 2650 && m.range[1] === 2950 && m.kcal_days === 28, m);
const thin = W.maintenanceFromData({ logs: logs.slice(0, 5), weighins }, TODAY);
ok('2 too few calorie logs → unknown, says exactly what is missing', thin.kcal === null && /9 more days of calorie logs \(have 5/.test(thin.need[0]), thin.need);
ok('3 no weigh-ins at the start → unknown', W.maintenanceFromData({ logs, weighins: weighins.slice(2) }, TODAY).kcal === null);
ok('4 gym days/week from his check-ins', W.gymDaysPerWeek(raw, TODAY) === 3);

let r = W.weightWhatIf({ kcal: 2000, gym_days: 3 }, raw, TODAY);
ok('5 projection is a range: kg/week and weeks', r.kg_per_week[0] === 0.59 && r.kg_per_week[1] === 0.86 && r.weeks[0] < r.weeks[1], { w: r.kg_per_week, k: r.weeks });
ok('6 starts from current 7-day mean, target from the weight goal (90 − 10)', r.now_kg === 88.5 && r.target_kg === 80 && r.to_lose_kg === 8.5);
ok('7 dates + verdict against the 12-week deadline', r.dates[0] && r.dates[1] && ['on_track', 'maybe', 'late'].includes(r.verdict) && /12-week goal ends 2027-02-20/.test(r.text), r.text);
ok('8 assumptions are written out', r.assumptions.some(a => /maintenance ≈ 2650–2950 kcal from your logs/.test(a)) && r.assumptions.some(a => /7700 kcal/.test(a)));
r = W.weightWhatIf({ kcal: 2000, gym_days: 5 }, raw, TODAY);
ok('9 more gym days than now → added burn shown as an assumption, faster', r.assumptions.some(a => /gym 5×\/week vs your recent 3×: \+2 sessions × 250–400/.test(a)) && r.kg_per_week[1] > 0.86, r.kg_per_week);
r = W.weightWhatIf({ kcal: 3000, gym_days: 3 }, raw, TODAY);
ok('10 at/above maintenance → "won\'t come down", no date', r.reach === null && /won't come down/.test(r.text) && !r.dates);
r = W.weightWhatIf({ kcal: 1300, gym_days: 6 }, raw, TODAY);
ok('11 crash diet flagged: too low + faster than the safe % a week', r.flags.some(f => /Below 1,500/.test(f)) && r.flags.some(f => /safe limit/.test(f)), r.flags);
r = W.weightWhatIf({ kcal: 2000, gym_days: 3 }, Object.assign({}, raw, { logs: logs.slice(0, 5) }), TODAY);
ok('12 not enough data → unknown with what to do (or enter your own maintenance)', r.unknown === true && /apna maintenance number khud daalo/.test(r.text));
r = W.weightWhatIf({ kcal: 2000, gym_days: 3, maintenance: 2600 }, Object.assign({}, raw, { logs: [] }), TODAY);
ok('13 his own maintenance number works without logs, labelled as his', !r.unknown && r.maintenance.source === 'the number you entered' && r.assumptions[0] === 'maintenance 2600 kcal is your own number (±150)');
r = W.weightWhatIf({ kcal: 2000, gym_days: 3 }, Object.assign({}, raw, { weighins: [] }), TODAY);
ok('14 no recent weigh-ins → unknown current weight', r.unknown === true && /weigh-ins/.test(r.text));
ok('15 input limits', !!W.weightWhatIf({ kcal: 800, gym_days: 3 }, raw, TODAY).error && !!W.weightWhatIf({ kcal: 2000, gym_days: 9 }, raw, TODAY).error && !!W.weightWhatIf({ kcal: 2000, gym_days: 3, target_kg: 95 }, raw, TODAY).error);
r = W.weightWhatIf({ kcal: 2000, gym_days: 3, target_kg: 85 }, Object.assign({}, raw, { weightGoal: null }), TODAY);
ok('16 own target without a weight goal; no deadline verdict', r.target_kg === 85 && r.verdict === null && !/12-week/.test(r.text));

let s = W.sleepWhatIf({ bed: '00:15', wake: '07:30' });
ok('17 sleep 00:15–07:30 → 7.25 h, fits all rules', s.hours === 7.25 && s.ok && /fits all/.test(s.text));
s = W.sleepWhatIf({ bed: '01:30', wake: '07:00' });
ok('18 1:30 bed → breaks 6h and 12:30 rules', !s.ok && /6h\+ sleep/.test(s.text) && /in bed by 12:30/.test(s.text), s.text);
s = W.sleepWhatIf({ bed: '23:30', wake: '09:00' });
ok('19 wake 9:00 → breaks "up by 8" and "1h before gym"', !s.ok && /up by 8/.test(s.text) && /before 9:30 gym/.test(s.text));
ok('20 bad times refused', !!W.sleepWhatIf({ bed: '25:00', wake: '07:00' }).error);

(async () => {
  const osPath = require('path').join(__dirname, '../api/os.js');
  let writes = 0, failLogs = false;
  global.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url)); const j = (b, st = 200) => ({ ok: st < 300, status: st, json: async () => b });
    if (init.method && init.method !== 'GET') writes++;
    if (u.includes('rpc/jeetos_is_owner')) return j(true);
    if (u.includes('/jeetos_logs')) return failLogs ? j({}, 401) : j(logs);
    if (u.includes('/jeetos_weighins')) return j(weighins);
    if (u.includes('/jeetos_anchor_checkins')) return j(checkins);
    if (u.includes('/jeetos_weight_goals')) return j([raw.weightGoal]);
    return j([]);
  };
  delete require.cache[osPath]; delete require.cache[require.resolve('../api/_auth.js')];
  const os = require(osPath), call = req => new Promise(res => os(Object.assign({ headers: { authorization: 'Bearer h.p.s' }, query: {} }, req), { status: c => ({ json: b => res({ code: c, body: b }) }) }));
  const RealNow = Date.now; Date.now = () => Date.parse(TODAY + 'T12:00:00+05:30');
  writes = 0;
  let x = await call({ method: 'POST', body: { action: 'whatif', kind: 'weight', kcal: 2000, gym_days: 3 } });
  ok('21 endpoint: weight projection from his data, nothing written', x.code === 200 && x.body.maintenance.kcal === 2750 && writes === 1, { code: x.code, w: writes });   // the one POST is the owner check
  x = await call({ method: 'POST', body: { action: 'whatif', kind: 'sleep', bed: '00:15', wake: '07:30' } });
  ok('22 endpoint: sleep', x.code === 200 && x.body.ok === true);
  failLogs = true;
  x = await call({ method: 'POST', body: { action: 'whatif', kind: 'weight', kcal: 2000, gym_days: 3 } });
  ok('23 unreadable logs → error, not a made-up projection', x.code === 502 && /logs/.test(x.body.error));
  Date.now = RealNow;
})();
