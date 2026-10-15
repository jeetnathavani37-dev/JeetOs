// Habit consistency (api/_habits.js): % over 7/30 days, unknown ≠ miss,
// recovery excused, minimum versions credited, blockers from check-ins.
const H = require('../api/_habits.js');
const { buildPacket } = require('../api/_context.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''));
const TODAY = '2026-11-16'; // Monday
const back = i => new Date(Date.parse(TODAY) - i * 864e5).toISOString().slice(0, 10);
const days = n => Array.from({ length: n }, (_, i) => back(i + 1));
const rep = raw => Object.fromEntries(H.habitReport(raw, TODAY).habits.map(h => [h.id, h]));

let r = rep({});
ok('1 no data → every habit "not enough data", never 0%', Object.values(r).filter(h => h.id !== 'logging').every(h => h.d7.pct === null && h.d30.pct === null));
ok('2 the logging habit itself reads 0% when nothing is logged (that IS the data)', r.logging.d7.pct === 0);

const logs = days(30).map((d, i) => ({ day: d, total_cal: i % 2 ? 2500 : 1900, junk_meals: 0, sleep_hours: 7, bedtime: '00:10', skincare_done: i < 7, gym_done: false }));
const checkins = days(30).filter(d => new Date(d + 'T12:00:00Z').getUTCDay() !== 0).slice(0, 5).map(d => ({ anchor: 'gym', day: d }));
r = rep({ logs, checkins });
ok('3 diet alternates → ~50% both windows', r.diet.d30.pct === 50 && Math.abs(r.diet.d7.pct - 50) <= 10, [r.diet.d7.pct, r.diet.d30.pct]);
ok('4 sleep every night → 100%', r.sleep.d7.pct === 100 && r.sleep.d30.pct === 100);
ok('5 skincare only this week → 7d 100%, 30d ~23%, trend up', r.skincare.d7.pct === 100 && r.skincare.d30.pct < 30 && r.skincare.trend === 'up', [r.skincare.d30.pct, r.skincare.trend]);
ok('6 gym counts Mon–Sat only (Sundays not in the denominator)', r.gym.d7.n === 6 && r.gym.d7.pct === 83, r.gym.d7);

const sick = { logs: days(7).map(d => ({ day: d, sleep_hours: 4, bedtime: '02:00' })), marks: days(7).slice(0, 4).map(d => ({ date: d, kind: 'recovery' })) };
r = rep(sick);
ok('7 recovery days excused, not counted as misses', r.sleep.d7.excused === 4 && r.sleep.d7.n === 3 && r.sleep.d7.pct === 0);
const gap = { logs: days(7).slice(0, 4).map(d => ({ day: d, sleep_hours: 7 })) };
r = rep(gap);
ok('8 days with no data are unknown, not misses (4/4 = 100%, 3 no-data)', r.sleep.d7.pct === 100 && r.sleep.d7.noData === 3);
const mins = { logs: days(7).map(d => ({ day: d, gym_done: false })), marks: days(7).filter(d => new Date(d + 'T12:00:00Z').getUTCDay() !== 0).slice(0, 2).map(d => ({ date: d, kind: 'min', habit: 'move' })) };
r = rep(mins);
ok('9 minimum version counts half (keeps the habit alive)', r.gym.d7.minimum === 2 && r.gym.d7.pct === 17, r.gym.d7);
const wake = { checkins: days(7).map((d, i) => ({ anchor: 'wake', day: d, at: `${d}T${i % 2 ? '02:20' : '03:10'}:00Z` })) };
r = rep(wake);
ok('10 wake on time = checked in by 8:00 IST', r.wake.d7.pct === 43, r.wake.d7);   // 3 of 7 by 07:50, 4 at 08:40

const ev = { dailyCheckins: days(10).map((d, i) => ({ day: d, kind: 'evening', answers: { blocker: i % 3 ? 'time' : 'energy', not_done: i % 2 ? ['Gym at 10:00 PM (45 min)'] : ['Send leg video'] } })) };
const b = H.habitReport(ev, TODAY).blockers;
ok('11 blockers ranked from his own answers', b.reasons[0].what === 'time' && b.reasons[0].times === 6 && b.evenings === 10, b);
ok('12 missed items grouped (time suffixes stripped)', b.missed.some(m => m.what === 'Gym' && m.times === 5), b.missed);
const lines = H.habitLines(H.habitReport(Object.assign({ logs, checkins }, ev), TODAY));
ok('13 packet lines: %, trend, and "patterns, not proof of cause"', lines.some(l => /^Diet .*7d \d+%, 30d 50%/.test(l)) && lines.some(l => /patterns, not proof of cause/.test(l)), lines);
const pk = buildPacket({ logs, checkins }, { coach: 'fitness', now: Date.parse('2026-11-16T10:00:00+05:30') });
ok('14 coaches get a HABIT CONSISTENCY section', /\[HABIT CONSISTENCY/.test(pk.text) && /Gym: 7d 83%/.test(pk.text));
