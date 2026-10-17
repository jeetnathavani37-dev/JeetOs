// Weekly CEO Review (api/_review.js): fixed numbers from stored data, Claude
// only narrates (and a narrative with an invented number is dropped), unknown ≠ miss.
const R = require('../api/_review.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''));
const SUN = '2026-11-15';
const add = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dow = d => new Date(d + 'T12:00:00Z').getUTCDay();

// 1-3 the week
let w = R.reviewWeek(SUN);
ok('1 on Sunday the review covers Sun..Sat ending yesterday', w.start === '2026-11-08' && w.end === '2026-11-14', w);
w = R.reviewWeek('2026-11-14');
ok('2 on Saturday it is still the previous full week', w.end === '2026-11-07', w);
w = R.reviewWeek('2026-11-18');
ok('3 midweek → last Saturday', w.end === '2026-11-14', w);

// A week: every day logged; gym checked in on time Mon–Wed, late Thu, missing Fri/Sat.
const week = Array.from({ length: 7 }, (_, i) => add('2026-11-08', i));
const prevWeek = Array.from({ length: 7 }, (_, i) => add('2026-11-01', i));
const logs = week.map(d => ({ day: d, total_cal: 1900, junk_meals: 0, sleep_hours: 7, bedtime: '00:10', skincare_done: true }))
  .concat(prevWeek.map(d => ({ day: d, total_cal: 2600, junk_meals: 1, sleep_hours: 7, bedtime: '00:10', skincare_done: false })));
const gym = (d, hm) => ({ anchor: 'gym', day: d, at: `${d}T${hm}:00+05:30` });
const checkins = [gym('2026-11-09', '09:35'), gym('2026-11-10', '09:30'), gym('2026-11-11', '09:40'), gym('2026-11-12', '11:30')];
const raw = { logs, checkins, marks: [], dailyCheckins: [], weighins: [], openPromises: [], decisions: [], graph: [], scheduleOverrides: [] };

let r = R.buildReview(raw, SUN, { closed: [], pending: [], entries: [] });
const gymH = r.habits.find(h => h.id === 'gym'), diet = r.habits.find(h => h.id === 'diet');
ok('4 diet ≤2,100 every day this week vs 0% the week before', diet.pct === 100 && diet.prev_pct === 0 && diet.change === 100, diet);
ok('5 gym habit counts Mon–Sat only', gymH.n === 6 && gymH.pct === 67, gymH);
ok('6 anchors: scheduled on data days, gym late on Thu and missing Fri/Sat', r.anchors.scheduled > 0 && r.anchors.missed_or_late.gym === 3, r.anchors.missed_or_late);
ok('7 a win only from numbers (diet 100%)', r.wins.some(x => /Diet.*100%/.test(x)), r.wins);
ok('8 no weigh-ins → weight unknown, and next week asks for weigh-ins', r.weight.avg_kg === null && r.next_top3.some(t => /weigh-in/.test(t.title)), r.next_top3);
ok('9 top 3 is at most 3 and never empty when something needs doing', r.next_top3.length >= 1 && r.next_top3.length <= 3);

// 10 days with no data are unknown, not misses
const sparse = Object.assign({}, raw, { logs: logs.filter(l => l.day === '2026-11-09'), checkins: [] });
r = R.buildReview(sparse, SUN, {});
ok('10 days with no data are counted as unknown (not missed)', r.anchors.no_data_days === 6, r.anchors);
// 11 recovery days excused
r = R.buildReview(Object.assign({}, raw, { marks: [{ date: '2026-11-13', kind: 'recovery' }, { date: '2026-11-14', kind: 'recovery' }] }), SUN, {});
ok('11 recovery days excused from anchors', r.anchors.excused_days === 2 && r.anchors.missed_or_late.gym === 1, r.anchors);

// 12-14 evening check-ins: planned vs done + recurring blockers
const ev = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'].map((d, i) => ({ day: d, kind: 'evening', answers: { done: i ? ['Library'] : ['Library', 'Gym'], not_done: i ? ['Gym at 10:00 PM (45 min)'] : [], blocker: i ? 'time' : undefined } }));
ev.push({ day: '2026-11-02', kind: 'evening', answers: { done: [], not_done: ['X', 'Y'], blocker: 'mood' } });  // last week: ignored
r = R.buildReview(Object.assign({}, raw, { dailyCheckins: ev }), SUN, {});
ok('12 planned vs done only from this week\'s evenings', r.evening.evenings === 4 && r.evening.planned === 8 && r.evening.done === 5 && r.evening.pct_done === 63, r.evening);
ok('13 recurring blocker "time" ×3; one-offs dropped', r.evening.blockers.length === 1 && r.evening.blockers[0].what === 'time' && r.evening.blockers[0].times === 3, r.evening.blockers);
ok('14 gym left undone 3 evenings → flagged as a plan that keeps failing', r.unrealistic.some(u => u.what === 'Gym' && /3 evenings/.test(u.why)), r.unrealistic);

// 15-17 promises, decisions, ledger
r = R.buildReview(raw, SUN, { closed: [{ owner: 'jeet', status: 'done' }, { owner: 'jeet', status: 'missed' }, { owner: 'coach', status: 'done' }], pending: [{ id: 'd1', coach: 'fitness', change: 'Gym 5x' }], entries: [{ amount_paise: 10000 }, { amount_paise: 10000 }, { amount_paise: -10000 }] });
ok('15 promises: coach-owned ones not counted', r.promises.done === 1 && r.promises.missed === 1, r.promises);
ok('16 pending proposals listed for approval', r.pending.length === 1 && r.next_top3.concat([]).length <= 3);
ok('17 ledger is net of reversals', r.fines.paise === 10000 && R.factLines(r).some(l => /Ledger entries this week: ₹100/.test(l)));
r = R.buildReview(raw, SUN, { failed: ['ledger'] });
ok('18 unreadable ledger → unknown, not ₹0', r.fines === null && r.unknown.includes('ledger') && R.factLines(r).some(l => /Couldn't read: ledger/.test(l)));

// 19-20 weight
const wi = (d, kg) => ({ id: d, day: d, kg, fasted: true, morning: true, measured_at: d + 'T02:00:00Z' });
r = R.buildReview(Object.assign({}, raw, { weighins: [wi('2026-11-03', 80), wi('2026-11-05', 80.4), wi('2026-11-10', 79.6), wi('2026-11-13', 79.4)] }), SUN, {});
ok('19 weight: 7-day averages compared to the week before', r.weight.avg_kg === 79.5 && r.weight.prev_avg_kg === 80.2 && r.weight.change_kg === -0.7, r.weight);
ok('20 a drop in the average is a win', r.wins.some(x => /down 0.7 kg/.test(x)), r.wins);

// 21-24 the narrative guard
const facts = R.factLines(r);
ok('21 facts are plain lines with the week', facts[0] === 'WEEK 2026-11-08 to 2026-11-14' && facts.some(l => /Weight 7-day average: 79.5 kg/.test(l)), facts.slice(0, 3));
ok('22 a narrative using only fact numbers passes', R.numbersOk('Weight 79.5 se neeche, diet 100% — solid hafta.', facts));
ok('23 an invented number is caught (even if the digits appear elsewhere, e.g. 12:30)', !R.numbersOk('Tumne 12 kg kam kiya!', facts) && R.numbersOk('12:30 tak so jao', facts) && !R.numbersOk('₹500 fine', facts));
(async () => {
  let n = await R.narrate(r, async () => 'Diet 100% raha. Weight 0.7 kg neeche. Gym time pe nahi hua. Agle hafte weigh-ins.');
  ok('24 good narrative kept', n.ai === true && /Diet 100%/.test(n.narrative), n);
  n = await R.narrate(r, async () => 'Tum 95% consistent the!');
  ok('25 narrative with a made-up % is dropped (numbers still shown)', n.narrative === null && /number/.test(n.rejected), n);
  n = await R.narrate(r, async () => { throw new Error('down'); });
  ok('26 Claude down → no narrative, review still works', n.narrative === null && n.ai === false);

  // 27-30 ensureReview: once per week
  const store = {};
  const q = async p => {
    if (p.startsWith('jeetos_weekly_reviews')) { const m = /week_end=eq\.([\d-]+)/.exec(p); return store[m[1]] ? [store[m[1]]] : []; }
    if (p.startsWith('jeetos_logs')) return logs;
    if (p.startsWith('jeetos_penalty_entries')) return null;      // owner-only, unreadable here
    return [];
  };
  let calls = 0;
  const write = async (p, row) => { calls++; if (store[row.week_end]) return { ok: true, status: 201, body: [] }; store[row.week_end] = row; return { ok: true, status: 201, body: [row] }; };
  const now = Date.parse('2026-11-15T21:00:00+05:30');
  const a = await R.ensureReview({ q, write, callClaude: async () => 'Diet 100% raha.', now, source: 'cron' });
  ok('27 first run creates the week\'s review', a.created === true && a.review.week_end === '2026-11-14' && a.review.ai === true, { c: a.created, e: a.review.week_end });
  ok('28 ledger unreadable is recorded as unknown', a.review.data.unknown.includes('ledger') && a.review.data.fines === null);
  const b = await R.ensureReview({ q, write, callClaude: async () => { throw new Error('should not be called'); }, now: now + 3600e3, source: 'app' });
  ok('29 second run is a no-op (same stored review)', b.created === false && b.review === store['2026-11-14'] && calls === 1);
  const c = await R.ensureReview({ q, write: async () => ({ ok: false, status: 403 }), callClaude: async () => 'x', now: Date.parse('2026-11-22T21:00:00+05:30') });
  ok('30 save failure is reported, not hidden', c.created === false && /403/.test(c.error));
})();
