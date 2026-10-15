const { buildPacket, loadContextData, anchorStatus, planDay, BUDGET } = require('../api/_context.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 260) : ''));
const T = s => Date.parse(s);
const has = (p, s) => p.text.includes(s);

// A realistic Tuesday: woke on time, gym in its extension window, breakfast logged.
const base = () => ({
  logs: [{ day: '2026-10-20', gym_done: false, sleep_hours: 6.5, bedtime: '00:40', total_protein: null, total_cal: 900, junk_meals: 0, water: 4, mood: 3, energy: null, entries_seen: { breakfast: '2026-10-20T11:20:00+05:30' } }],
  checkins: [{ anchor: 'wake', day: '2026-10-20', at: '2026-10-20T08:05:00+05:30', verified: true }],
  marks: [],
  openPromises: [
    { id: 'p1', coach: 'fitness', text: 'Leg day video bhejna', due: '2026-10-20', owner: 'jeet', staked: true },
    { id: 'p2', coach: 'nutrition', text: 'Meal prep Sunday', due: '2026-10-25', owner: 'jeet' },
    { id: 'p3', coach: 'fitness', text: 'Send him a deload plan', due: '2026-10-21', owner: 'coach' },
  ],
  closedPromises: [{ coach: 'fitness', text: '10k steps', status: 'missed', owner: 'jeet', blocker: 'exam', resolved_at: '2026-10-18T22:00:00+05:30' }],
  goals: [
    { id: 'g1', coach: 'fitness', text: 'Bench 60 kg', unit: 'kg', start_value: 40, target: 60, current_value: 45, deadline: '2026-12-31', history: [{ v: 45, d: '2026-10-15' }], created_at: '2026-09-01T00:00:00Z' },
    { id: 'g2', coach: 'skin', text: 'Clear forehead', unit: null, start_value: null, target: null, current_value: null, deadline: null, history: [], created_at: '2026-10-01T00:00:00Z' },
  ],
  goalState: { goalId: 'g1', today: { date: '2026-10-20', text: 'Gym before 10', done: false } },
  weightGoal: { status: 'active', baseline_kg: 92, baseline_day: '2026-10-05', start_day: '2026-10-05', target_loss_kg: 10, end_day: '2026-12-28', ext_end_day: '2027-01-18' },
  weighins: [
    { id: 'w1', day: '2026-10-20', kg: 90.4, fasted: true, morning: true, measured_at: '2026-10-20T08:10:00+05:30' },
    { id: 'w2', day: '2026-10-19', kg: 90.6, fasted: true, morning: true, measured_at: '2026-10-19T08:10:00+05:30' },
    { id: 'w3', day: '2026-10-12', kg: 91.2, fasted: true, morning: true, measured_at: '2026-10-12T08:10:00+05:30' },
  ],
  memory: [{ fact: 'Has college exams till 30 Oct', from_coach: 'mind', created_on: '2026-10-14' }],
  profile: { data: { routine: [{ t: 'Library 12:30-10 PM', d: '2026-10-10', src: 'chat' }], struggles: [{ t: 'Late-night phone', d: '2026-06-01', src: 'sleep' }] } },
  notes: [{ from_coach: 'sleep', to_coach: 'fitness', text: 'He slept late, keep gym light', created_at: '2026-10-20T07:00:00Z' }, { from_coach: 'mind', to_coach: 'skin', text: 'private-ish', created_at: '2026-10-20T07:00:00Z' }],
  inbox: [{ coach: 'fitness', slot: 'a_gym', text: 'Gym chal bhai', created_on: '2026-10-20', created_at: '2026-10-20T04:12:00Z' }],
  passes: [{ category: 'a_wake', day: '2026-10-12', kind: 'pass' }, { category: 'gym', day: '2026-10-11', kind: 'pass' }],
  incidents: [{ id: 'i1', category: 'anchor', title: 'Lunch late', status: 'assessed', updated_at: '2026-10-19T16:00:00Z' }],
  disputes: [],
  decisions: [{ coach: 'nutrition', area: 'diet', change: 'Dinner by 11 PM', decided_at: '2026-10-16T10:00:00Z' }],
});
const NOW = T('2026-10-20T09:45:00+05:30'); // Tuesday, gym 9:30 + 30 min extension

let p = buildPacket(base(), { coach: 'fitness', purpose: 'chat', now: NOW });
ok('1 header + IST time', has(p, 'TEAM CONTEXT for Marcus') && has(p, 'Tue 20 Oct 2026, 9:45 AM IST'));
ok('2 primary goal with pace', has(p, '"Bench 60 kg"') && /behind \(expected ~/.test(p.text), p.sections.find(s => s.key === 'primary'));
ok('3 today priority shown', has(p, "Today's one priority: \"Gym before 10\" — not done yet"));
const st = Object.fromEntries(p.anchors.map(a => [a.key, a.state]));
ok('4 anchor states: wake done, gym in extension, breakfast done (meal log), lunch upcoming', st.wake === 'done' && st.gym === 'in extension' && st.breakfast === 'done' && st.lunch === 'upcoming', st);
ok('5 next action = gym extension window', /Gym reporting" is in its extension window until 10:00 AM/.test(p.nextAction), p.nextAction);
ok('6 missing log values are unknown, not failure', has(p, 'protein not logged') && has(p, 'NO DATA — never treat it as failure') && !has(p, 'protein 0'));
ok('7 weight visible to fitness, with trend + pace', has(p, 'baseline 92 kg → target 82 kg') && has(p, '7-day mean'), p.sections.find(s => s.key === 'primary').lines);
ok('8 own promises only, others as a count', has(p, 'Leg day video bhejna') && !has(p, 'Meal prep Sunday') && has(p, '+1 open promise(s) with teammates'));
ok('9 coach-owed promise surfaced', has(p, 'YOU promised him: "Send him a deload plan"'));
ok('10 recent outcome with blocker', has(p, '"10k steps" → missed (blocker: exam)'));
ok('11 teammate note to this coach only', has(p, 'He slept late, keep gym light') && !has(p, 'private-ish'));
ok('12 money hidden from fitness', !has(p, 'LEDGER') && !has(p, 'Lunch late'));
ok('13 memory carries date + source', has(p, 'Has college exams till 30 Oct (6 days ago, noted by Dr. Meher)') && has(p, 'Late-night phone (5 months ago, from sleep)'), (p.sections.find(s => s.key === 'memory') || {}).lines);
ok('14 last ping + whether it landed', has(p, '"Gym chal bhai" → Gym reporting is now: in extension'));
ok('15 passes summarised', has(p, 'wake 1/5') && has(p, 'gym 1/7'));

// Access matrix
const skin = buildPacket(base(), { coach: 'skin', purpose: 'chat', now: NOW });
ok('16 skin: no weight numbers, no money, own goal listed', !has(skin, 'baseline 92') && !has(skin, '7-day mean') && !has(skin, 'LEDGER') && has(skin, 'yours: "Clear forehead"'), skin.sections.filter(s => s.key === 'goals' || s.key === 'primary'));
const mind = buildPacket(base(), { coach: 'mind', purpose: 'chat', now: NOW });
ok('17 mind: no weight numbers, no ledger', !has(mind, '7-day mean') && !has(mind, 'LEDGER'));
const cr7 = buildPacket(base(), { coach: 'ronaldo', purpose: 'chat', now: NOW });
ok('18 ronaldo (accountability): ledger + all promises + all goals', has(cr7, 'Lunch late: assessed') && has(cr7, 'Meal prep Sunday') && has(cr7, '"Clear forehead"'));
const unknownCoach = buildPacket(base(), { coach: 'hacker', now: NOW });
ok('19 unknown coach id falls back to head scope', unknownCoach.coach === 'head');

// Same facts for chat and cron
const a = buildPacket(base(), { coach: 'nutrition', purpose: 'chat', now: NOW });
const b = buildPacket(base(), { coach: 'nutrition', purpose: 'nudge', now: NOW });
ok('20 chat and cron see the same next action + anchors', a.nextAction === b.nextAction && JSON.stringify(a.anchors) === JSON.stringify(b.anchors));

// Budget
const big = base();
big.memory = Array.from({ length: 200 }, (_, i) => ({ fact: 'fact number ' + i + ' ' + 'x'.repeat(80), from_coach: 'team', created_on: '2026-10-01' }));
const small = buildPacket(big, { coach: 'fitness', purpose: 'nudge', now: NOW });
ok('21 budget respected (nudge)', small.text.length <= BUDGET.nudge, small.text.length);
ok('22 trimming keeps NOW / PRIMARY / NEXT ACTION', has(small, '[NOW]') && has(small, '[PRIMARY GOAL]') && has(small, '[NEXT ACTION]'));
ok('23 trimming drops memory tail first, keeps schedule', has(small, '[TODAY\'S SCHEDULE') && !has(small, 'fact number 199'));

// Night: after midnight the schedule still belongs to the previous day
const night = base();
const n1 = T('2026-10-21T00:45:00+05:30');
ok('24 planDay before 4 AM = previous day', planDay(n1) === '2026-10-20' && planDay(T('2026-10-21T05:00:00+05:30')) === '2026-10-21');
const ns = Object.fromEntries(anchorStatus(night, n1).map(a => [a.key, a.state]));
ok('25 sleep anchor at 12:45 AM is in extension (not tomorrow)', ns.sleep === 'in extension', ns);
night.checkins.push({ anchor: 'sleep', day: '2026-10-20', at: '2026-10-21T00:20:00+05:30' });
ok('26 sleep check-in after midnight counts for the plan day', Object.fromEntries(anchorStatus(night, n1).map(a => [a.key, a.state])).sleep === 'done');

// Sunday: gym / work / leave aren't on the schedule
const sun = Object.fromEntries(anchorStatus({ logs: [], checkins: [] }, T('2026-10-25T10:00:00+05:30')).map(a => [a.key, a.state]));
ok('27 Sunday skips Mon–Sat anchors', !('gym' in sun) && !('work' in sun) && !('leave' in sun) && 'wake' in sun, Object.keys(sun));

// Recovery day
const sick = base(); sick.marks = [{ date: '2026-10-20', habit: 'move', kind: 'recovery', reason: 'fever' }];
ok('28 recovery day flagged as no-push', has(buildPacket(sick, { coach: 'fitness', now: NOW }), "TODAY is a recovery day: don't push"));

// Empty data: nothing crashes, everything is unknown
const empty = buildPacket({}, { coach: 'fitness', now: NOW });
ok('29 empty data → no crash, says unknown', has(empty, 'No primary goal set yet (unknown)') && has(empty, 'nothing logged yet') && has(empty, 'no open promises'));

// Overdue promise drives next action when no anchor is pending
const od = base(); od.checkins.push({ anchor: 'gym', day: '2026-10-20', at: '2026-10-20T09:40:00+05:30' });
const odp = buildPacket(od, { coach: 'fitness', now: NOW });
ok('30 due promise is the next action once gym is done', /Promise due today: "Leg day video bhejna"/.test(odp.nextAction), odp.nextAction);

// Loader: newest-first queries, IST plan day, no "asc&limit" truncation of memory
(async () => {
  const paths = [];
  await loadContextData(async p => { paths.push(p); return []; }, NOW);
  ok('31 loader asks for memory newest-first', paths.some(p => p.startsWith('jeetos_team_memory') && p.includes('order=created_at.desc')));
  ok('32 loader keys logs on the IST plan day', paths.some(p => p.startsWith('jeetos_logs?day=in.(2026-10-20,2026-10-19)')), paths[0]);
  ok('33 loader never reads safety events or photos', !paths.some(p => /safety_events|photo_vault/.test(p)));
  const half = await loadContextData(async p => (p.startsWith('jeetos_commitments') ? null : []), NOW);
  const hp = buildPacket(half, { coach: 'fitness', now: NOW });
  ok('34 unreadable table is flagged unknown, not "no promises"', hp.failed.includes('openPromises') && /couldn't read part of his data right now \(openPromises, closedPromises\)/.test(hp.text), hp.failed);
})();
