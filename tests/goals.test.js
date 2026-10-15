// Goal graph: health maths (api/_goals.js), roll-up, approval, target limits,
// the endpoint (api/os.js) and what reaches the coaches (api/_context.js).
const G = require('../api/_goals.js');
const { buildPacket } = require('../api/_context.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 260) : ''));
const TODAY = '2026-11-16'; // Monday
const goals = G.approvalRows([], '2026-10-01T00:00:00Z');
const byId = id => goals.find(g => g.id === id);
const days = n => Array.from({ length: n }, (_, i) => { const d = new Date(Date.parse(TODAY) - (7 - i) * 864e5); return d.toISOString().slice(0, 10); });
const W = days(7); // 9..15 Nov (Mon..Sun)

ok('1 proposal = 1 primary + 4 supporting, all pointing at it', goals.length === 5 && goals.filter(g => g.kind === 'primary').length === 1 && goals.filter(g => g.parent_id === 'weight10').length === 4);
ok('2 re-approving creates nothing new', G.approvalRows(goals, 'x').length === 0);

// Diet
const diet = (cals, junk = []) => G.HEALTH.diet_kcal(byId('diet'), { logs: W.map((d, i) => cals[i] == null ? null : { day: d, total_cal: cals[i], junk_meals: junk[i] || 0 }).filter(Boolean) }, TODAY);
ok('3 diet: 3 logged days → unknown, not failure', diet([1900, null, 2000, null, null, 1800, null]).state === 'unknown');
ok('4 diet: 7/7 within 2,100 → on track', diet([1900, 2000, 2100, 1800, 1950, 2050, 1700]).state === 'on_track');
ok('5 diet: junk meal counts as a miss', diet([1900, 2000, 2100, 1800, 1950, 2050, 1700], [0, 1, 1, 0, 0, 0, 0]).state === 'behind', diet([1900, 2000, 2100, 1800, 1950, 2050, 1700], [0, 1, 1, 0, 0, 0, 0]));
ok('6 diet: mostly over → at risk', diet([2500, 2600, 2100, 2800, 2400, 2000, 2300]).state === 'at_risk');

// Gym
const gym = (doneDays, opts = {}) => G.HEALTH.gym_days(byId('gym'), { logs: W.map(d => ({ day: d, gym_done: false })), checkins: doneDays.map(d => ({ anchor: 'gym', day: d })), marks: opts.marks || [] }, opts.today || TODAY);
ok('7 gym: no logs and no check-ins → unknown', G.HEALTH.gym_days(byId('gym'), { logs: [], checkins: [] }, TODAY).state === 'unknown');
ok('8 gym: 5 of 6 scheduled days → on track', gym(W.slice(0, 5)).state === 'on_track');
ok('9 gym: 3 days → behind', gym(W.slice(0, 3)).state === 'behind');
ok('10 gym: 1 day → at risk', gym(W.slice(0, 1)).state === 'at_risk');
ok('11 gym: recovery days lower the target', gym(W.slice(0, 3), { marks: [{ date: W[3], kind: 'recovery' }, { date: W[4], kind: 'recovery' }, { date: W[5], kind: 'recovery' }] }).state === 'on_track');
ok('12 gym: today counts only once done', gym(W.slice(0, 4).concat([TODAY])).n === 5);

// Sleep
const sleep = rows => G.HEALTH.sleep_window(byId('sleep'), { logs: rows.map((r, i) => r && Object.assign({ day: W[i] }, r)).filter(Boolean) }, TODAY);
ok('13 sleep: <4 nights logged → unknown', sleep([{ sleep_hours: 7 }, null, { sleep_hours: 7 }]).state === 'unknown');
ok('14 sleep: 6h+ and in bed by 12:30 → on track', sleep(Array(7).fill({ sleep_hours: 7, bedtime: '00:15' })).state === 'on_track');
ok('15 sleep: 11:50 PM bedtime counts as on time', sleep(Array(7).fill({ sleep_hours: 7, bedtime: '11:50 pm' })).state === 'on_track');
ok('16 sleep: late (1:30 AM) nights → at risk', sleep(Array(7).fill({ sleep_hours: 7, bedtime: '01:30' })).state === 'at_risk');
ok('17 sleep: short nights → miss', sleep([{ sleep_hours: 5 }, { sleep_hours: 5 }, { sleep_hours: 7 }, { sleep_hours: 7 }, { sleep_hours: 7 }, { sleep_hours: 7 }, { sleep_hours: 7 }]).state === 'behind');

// Weigh-in
const wi = d => G.HEALTH.weighin_weekly(byId('weighin'), { weighins: d.map(x => ({ day: x, fasted: true, morning: true, kg: 90 })) }, TODAY);
ok('18 weigh-in: none → unknown', wi([]).state === 'unknown');
ok('19 weigh-in: 3 days ago → on track', wi(['2026-11-13']).state === 'on_track');
ok('20 weigh-in: 10 days ago → behind; 20 → at risk', wi(['2026-11-06']).state === 'behind' && wi(['2026-10-27']).state === 'at_risk');
ok('21 weigh-in: non-fasted ones don\'t count', G.HEALTH.weighin_weekly(byId('weighin'), { weighins: [{ day: '2026-11-15', fasted: false, morning: true }] }, TODAY).state === 'unknown');

// Weight (primary)
ok('22 weight: plan not started → unknown with the reason', /isn't started in the Ledger/.test(G.HEALTH.weight(byId('weight10'), {}, TODAY).detail));
const wg = { baseline_kg: 92, target_loss_kg: 10, start_day: '2026-10-05', baseline_day: '2026-10-05', end_day: '2026-12-28', status: 'active' };
const kg = (vals, from) => vals.map((v, i) => ({ id: 'w' + i, day: new Date(Date.parse(from) + i * 864e5).toISOString().slice(0, 10), kg: v, fasted: true, morning: true, measured_at: '' }));
const wOn = G.HEALTH.weight(byId('weight10'), { weightGoal: wg, weighins: kg([86.4, 86.3, 86.2, 86.2, 86.1, 86.1, 86.0], '2026-11-10').concat(kg([86.9, 86.8, 86.8, 86.7, 86.7, 86.6, 86.6], '2026-11-03')) }, TODAY);
ok('23 weight: ~5.8 kg lost by week 6 → on track', wOn.state === 'on_track', wOn);
const wSlow = G.HEALTH.weight(byId('weight10'), { weightGoal: wg, weighins: kg(Array(7).fill(91.5), '2026-11-10').concat(kg(Array(7).fill(91.6), '2026-11-03')) }, TODAY);
ok('24 weight: 0.5 kg lost by week 6 → at risk', wSlow.state === 'at_risk', wSlow.detail);
const wFast = G.HEALTH.weight(byId('weight10'), { weightGoal: wg, weighins: kg(Array(7).fill(84), '2026-11-10').concat(kg(Array(7).fill(86), '2026-11-03')) }, TODAY);
ok('25 weight: >1%/week loss → at risk (too fast)', wFast.state === 'at_risk' && /faster than safe/.test(wFast.detail));

// Roll-up
const rawRisk = { logs: W.map(d => ({ day: d, gym_done: false, total_cal: 2600, sleep_hours: 7, bedtime: '00:10' })), checkins: [W[0]].map(d => ({ anchor: 'gym', day: d })), weighins: [] };
const h = G.graphHealth(goals, rawRisk, TODAY);
ok('26 roll-up: at-risk supporting goals flag the primary', h.primary.needs_review && h.primary.flags.some(f => /Gym 5\+ days/.test(f)) && h.primary.flags.some(f => /Calories/.test(f)), h.primary.flags);
const hEmpty = G.graphHealth(goals, {}, TODAY);
ok('27 roll-up: no data → "too little data", not a review', !hEmpty.primary.needs_review && hEmpty.primary.flags.some(f => /too little data/.test(f)));
ok('28 cancelled goals are ignored', G.graphHealth(goals.map(g => g.id === 'gym' ? Object.assign({}, g, { status: 'cancelled' }) : g), rawRisk, TODAY).goals.every(g => g.id !== 'gym'));

// Targets
ok('29 target tune within range', JSON.stringify(G.cleanTarget(byId('gym'), { per_week: 4 })) === '{"per_week":4}');
ok('30 target out of range / unknown key rejected', G.cleanTarget(byId('gym'), { per_week: 9 }) === null && G.cleanTarget(byId('diet'), { kcal: 900 }) === null && G.cleanTarget(byId('gym'), { kcal: 2000 }) === null);

// Packet
const raw = Object.assign({ graph: goals }, rawRisk, { weightGoal: wg, weighins: kg(Array(7).fill(91.5), '2026-11-10') });
const NOW = Date.parse('2026-11-16T10:00:00+05:30');
const fit = buildPacket(raw, { coach: 'fitness', now: NOW }), skin = buildPacket(raw, { coach: 'skin', now: NOW });
ok('31 packet: primary + health + flags + supporting goals', /Lose 10 kg in 12 weeks.* — AT RISK/.test(fit.text) && /⚑ Gym 5\+ days/.test(fit.text) && /supporting \(YOURS\): Gym 5\+ days a week \(Mon–Sat\) \[Marcus\] — AT RISK/.test(fit.text), fit.sections.find(s => s.key === 'primary').lines);
ok('32 packet: coaches told never to change targets themselves', /never change targets yourself/.test(fit.text));
ok('33 packet: skin coach sees the state but not the kg detail', /Lose 10 kg in 12 weeks, at a healthy pace — AT RISK\n/.test(skin.text) && !/lost 0\.5 kg/.test(skin.text));

// Endpoint
const osPath = require('path').join(__dirname, '../api/os.js');
function server() {
  const db = { goals: [], ev: [] };
  global.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url));
    const j = (b, st = 200) => ({ ok: st < 300, status: st, json: async () => b });
    if (u.includes('rpc/jeetos_is_owner')) return j(true);
    if (u.includes('/jeetos_goal_events')) { db.ev.push(...JSON.parse(init.body)); return j(null, 201); }
    if (u.includes('/jeetos_goals')) {
      const id = /id=eq\.([a-z0-9_]+)/.exec(u);
      if (init.method === 'POST') { const row = JSON.parse(init.body); if (db.goals.some(g => g.id === row.id)) return j({}, 409); if (row.parent_id && !db.goals.some(g => g.id === row.parent_id)) return j({ message: 'fk' }, 409); db.goals.push(row); return j([row], 201); }
      const hit = id ? db.goals.filter(g => g.id === id[1]) : u.includes('status=eq.active') ? db.goals.filter(g => g.status === 'active') : db.goals;
      if (init.method === 'PATCH') { hit.forEach(g => Object.assign(g, JSON.parse(init.body))); return j(hit); }
      return j(hit);
    }
    return j([]);
  };
  delete require.cache[osPath]; delete require.cache[require.resolve('../api/_auth.js')];
  const hd = require(osPath);
  return { db, call: req => new Promise(res => hd(Object.assign({ headers: { authorization: 'Bearer h.p.s' }, query: {} }, req), { status: c => ({ json: b => res({ code: c, body: b }) }) })) };
}
(async () => {
  const s = server();
  let x = await s.call({ method: 'GET', query: { action: 'goals' } });
  ok('34 before approval: no goals, the proposal is offered', x.code === 200 && x.body.goals.length === 0 && x.body.proposal.length === 5);
  x = await s.call({ method: 'POST', body: { action: 'goals.approve' } });
  ok('35 approve creates primary first, then 4 supporting', x.body.created[0] === 'weight10' && x.body.created.length === 5 && s.db.ev.length === 5);
  x = await s.call({ method: 'POST', body: { action: 'goals.approve' } });
  ok('36 approving twice is a no-op', x.body.created.length === 0 && s.db.goals.length === 5);
  x = await s.call({ method: 'GET', query: { action: 'goals' } });
  ok('37 after approval: health for all 5, no proposal', x.body.health.length === 5 && x.body.proposal === null && x.body.primary.id === 'weight10');
  x = await s.call({ method: 'POST', body: { action: 'goals.target', id: 'gym', target: { per_week: 4 } } });
  ok('38 tune gym to 4/week, audited with from/to', x.code === 200 && s.db.goals.find(g => g.id === 'gym').target.per_week === 4 && s.db.ev.slice(-1)[0].detail.from.per_week === 5);
  x = await s.call({ method: 'POST', body: { action: 'goals.target', id: 'gym', target: { per_week: 12 } } });
  ok('39 out-of-range target refused', x.code === 400);
  x = await s.call({ method: 'POST', body: { action: 'goals.cancel', id: 'sleep', reason: 'exam month' } });
  ok('40 cancel (status, not delete) + resume', x.code === 200 && s.db.goals.find(g => g.id === 'sleep').status === 'cancelled' && (await s.call({ method: 'POST', body: { action: 'goals.resume', id: 'sleep' } })).code === 200 && s.db.goals.find(g => g.id === 'sleep').status === 'active');
})();
