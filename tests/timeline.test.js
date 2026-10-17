// Evolution timeline (api/_timeline.js): only stored records, newest first, each with its source.
const TL = require('../api/_timeline.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''));

const src = {
  goals: [{ id: 'p', title: 'Lose 10 kg' }, { id: 'diet', title: 'Diet ≤ 2,100 kcal' }],
  goalEvents: [
    { id: 1, goal_id: 'p', action: 'approve', detail: {}, at: '2026-10-01T10:00:00Z' },
    { id: 2, goal_id: 'diet', action: 'target', detail: { from: { kcal: 2100, days: 6 }, to: { kcal: 2000, days: 6 } }, at: '2026-10-05T10:00:00Z' },
    { id: 3, goal_id: 'diet', action: 'cancel', detail: { reason: 'exams' }, at: '2026-10-06T10:00:00Z' },
    { id: 4, goal_id: 'diet', action: 'weird', detail: {}, at: '2026-10-06T11:00:00Z' },
  ],
  decisions: [
    { id: 'd1', status: 'approved', coach: 'fitness', change: 'Gym 5x a week', expected_outcome: '0.5 kg/week', decided_at: '2026-10-02T10:00:00Z', verdict: 'didnt', actual_outcome: 'only 3x', outcome_at: '2026-10-16T10:00:00Z' },
  ],
  memoryEvents: [
    { id: 'e1', memory_id: 'm1', action: 'supersede', detail: { by: 'm2', new_text: 'Works at the library 12:30–10' }, at: '2026-10-03T10:00:00Z' },
    { id: 'e2', memory_id: 'm9', action: 'retract', detail: { reason: 'wrong' }, at: '2026-10-04T10:00:00Z' },
  ],
  memories: [{ id: 'm1', text: 'Works at the library 2–10' }],
  experiments: [
    { id: 'x1', kind: 'measured', action: 'Charger outside', target: 'Sleep hours', baseline: '6.25 h', criterion: '+0.5 h vs baseline', status: 'worked', outcome: '6.25 h → 7 h', created_at: '2026-10-07T10:00:00Z', decided_at: '2026-10-21T10:00:00Z' },
    { id: 'x2', kind: 'coach', action: 'Protein at breakfast', status: 'running', created_at: '2026-10-08T10:00:00Z' },
    { id: 'x3', kind: 'coach', action: 'Walk after lunch', status: 'failed', outcome: 'no energy change', created_at: '2026-10-08T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' },
  ],
  reviews: [{ week_start: '2026-10-11', week_end: '2026-10-17', data: { anchors: { scheduled: 50, pct_on_time: 80 }, evening: { planned: 10, pct_done: 60 }, weight: { change_kg: -0.4 } } }],
  weightGoals: [{ id: 'w1', status: 'baseline', requested_at: '2026-10-01T09:00:00Z', target_loss_kg: 10, weeks: 12, baseline_kg: null }],
  schedule: { overrides: [{ anchor: 'gym', time: '10:15', was: '09:30', from: '2026-10-10', approved_at: '2026-10-09T10:00:00Z', evidence: { late_days: 4, of_days: 6 } }] },
};
const t = TL.buildTimeline(src);
const titles = t.map(x => x.title);
ok('1 newest first', t.every((x, i) => !i || t[i - 1].at >= x.at), titles.slice(0, 4));
ok('2 every entry points to its stored record', t.every(x => x.ref && x.ref.table && x.ref.id != null));
ok('3 goal plan approval + target change shown as a readable diff', titles.includes('Goal plan approved: Lose 10 kg') && t.some(x => x.title === 'Diet ≤ 2,100 kcal: target changed' && x.detail === 'kcal 2100 → 2000'), t.filter(x => x.kind === 'goal'));
ok('4 pause has its reason; unknown goal actions are ignored', t.some(x => /paused/.test(x.title) && x.detail === 'exams') && !titles.some(x => /weird/.test(x)));
ok('5 decision + its review (didn\'t work, with what actually happened)', titles.includes('Decided: Gym 5x a week') && t.some(x => x.title === "Reviewed: Gym 5x a week — didn't work" && x.detail === 'only 3x'));
ok('6 a replaced fact shows old → new', titles.includes('Changed: "Works at the library 2–10" → "Works at the library 12:30–10"'));
ok('7 a removed fact with unknown text says so (nothing invented)', t.some(x => x.title === 'A fact was removed' && x.detail === 'wrong'));
ok('8 measured experiment: start + verdict', titles.includes('Experiment started: Charger outside') && titles.includes('Experiment worked: Charger outside'));
ok('9 coach experiments only once they have a result', titles.includes('Coach experiment failed: Walk after lunch') && !titles.some(x => /Protein at breakfast/.test(x)));
ok('10 weekly review headline numbers', t.some(x => x.kind === 'review' && x.detail === 'anchors on time 80% · plan done 60% · weight -0.4 kg'), t.filter(x => x.kind === 'review'));
ok('11 weight goal with baseline pending', t.some(x => x.title === 'Weight goal set: −10 kg in 12 weeks' && /baseline pending/.test(x.detail)));
ok('12 schedule change with its evidence', t.some(x => x.title === 'gym: 09:30 → 10:15 from 2026-10-10' && x.detail === 'late 4 of 6 days'));
ok('13 filter by kind', TL.buildTimeline(src, { kinds: ['experiment'] }).every(x => x.kind === 'experiment'));
ok('14 paging with before', TL.buildTimeline(src, { before: '2026-10-05T00:00:00.000Z' }).every(x => x.at < '2026-10-05'));
ok('15 empty sources → empty timeline, no crash', TL.buildTimeline({}).length === 0 && TL.buildTimeline(null).length === 0);
ok('16 IST day used for grouping', t.find(x => x.kind === 'review').day === '2026-10-17');

(async () => {
  const osPath = require('path').join(__dirname, '../api/os.js');
  global.fetch = async (url) => {
    const u = decodeURIComponent(String(url)); const j = (b, st = 200) => ({ ok: st < 300, status: st, json: async () => b });
    if (u.includes('rpc/jeetos_is_owner')) return j(true);
    if (u.includes('/jeetos_goal_events')) return j(src.goalEvents);
    if (u.includes('/jeetos_goals')) return j(src.goals);
    if (u.includes('/jeetos_memory_events')) return j(src.memoryEvents);
    if (u.includes('/jeetos_memories?id=in.(m1,m9)')) return j(src.memories);
    if (u.includes('/jeetos_weekly_reviews')) return j({ message: 'denied' }, 401);
    if (u.includes('/jeetos_settings')) return j([{ data: src.schedule }]);
    return j([]);
  };
  delete require.cache[osPath]; delete require.cache[require.resolve('../api/_auth.js')];
  const os = require(osPath), call = req => new Promise(res => os(Object.assign({ headers: { authorization: 'Bearer h.p.s' }, query: {} }, req), { status: c => ({ json: b => res({ code: c, body: b }) }) }));
  let x = await call({ method: 'GET', query: { action: 'timeline' } });
  ok('17 endpoint: entries from several sources, memory text looked up', x.code === 200 && x.body.entries.some(e => /^Changed: "Works at the library 2–10"/.test(e.title)) && x.body.entries.some(e => e.kind === 'schedule'), x.body.entries.map(e => e.title).slice(0, 5));
  ok('18 unreadable table is reported, not silently empty', x.body.unreadable.includes('reviews'));
  x = await call({ method: 'GET', query: { action: 'timeline', kind: 'goal,bogus' } });
  ok('19 kind filter (unknown kinds ignored)', x.body.entries.length > 0 && x.body.entries.every(e => e.kind === 'goal'));
})();
