const { POLICY_V1, plan, istAt } = require('../api/_penalty.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 260) : ''));
const P = Object.assign({}, POLICY_V1, { effective_from: '2026-10-19T00:00:00+05:30' });
const T = s => Date.parse(s);
const staked = (o) => Object.assign({ id: 'c1', text: 'Send deck', coach: 'fitness', owner: 'jeet', status: 'open', staked: true,
  agreed_at: '2026-10-19T10:00:00+05:30', deadline_at: '2026-10-20T23:00:00+05:30', done_at: null, resolved_at: null }, o);
const allLogs = (dates) => dates.map(d => ({ day: d, entries: { breakfast: 1, lunch: 1, dinner: 1, sleep: 1 }, entries_seen: { breakfast: d + 'T09:00:00+05:30', lunch: d + 'T13:00:00+05:30', dinner: d + 'T21:00:00+05:30', sleep: d + 'T08:00:00+05:30' } }));
const days = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];
const run = (o) => plan(Object.assign({ policy: P, commitments: [], logs: allLogs(days), entries: [], incidents: [] }, o));
const amounts = r => r.entries.map(e => e.amount_paise);

// 1 done on time
let r = run({ commitments: [staked({ status: 'done', done_at: '2026-10-20T20:00:00+05:30', resolved_at: '2026-10-20T20:00:00+05:30' })], now: T('2026-10-25T12:00:00+05:30') });
ok('1 done on time → no penalty', r.entries.length === 0);
// 2 missed once (checkpoint 21 Oct 01:00)
r = run({ commitments: [staked()], now: T('2026-10-21T02:00:00+05:30') });
ok('2 missed once → one ₹250', JSON.stringify(amounts(r)) === '[25000]' && r.entries[0].local_date === '2026-10-21', r.entries.map(e => [e.local_date, e.amount_paise]));
// 3 still overdue → doubling to cap, then review
r = run({ commitments: [staked()], now: T('2026-10-25T12:00:00+05:30') });
ok('3 escalation 250/500/1000 then review', JSON.stringify(amounts(r)) === '[25000,50000,100000]' && r.incidents[0].status !== 'escalating', [amounts(r), r.incidents[0].status]);
// 4 cron twice → second run adds nothing
const first = run({ commitments: [staked()], now: T('2026-10-22T02:00:00+05:30') });
const second = run({ commitments: [staked()], now: T('2026-10-22T03:00:00+05:30'), entries: first.entries });
ok('4 cron runs twice same day → no duplicate', first.entries.length === 2 && second.entries.length === 0);
// late cron: run 2 days late still keys entries on the eligible dates
r = run({ commitments: [staked()], now: T('2026-10-23T05:00:00+05:30') });
ok('   late cron keys by eligible date', JSON.stringify(r.entries.map(e => e.local_date)) === '["2026-10-21","2026-10-22","2026-10-23"]');
// completed late: stops after the checkpoint it missed
r = run({ commitments: [staked({ status: 'done', done_at: '2026-10-21T15:00:00+05:30', resolved_at: '2026-10-21T15:00:00+05:30' })], now: T('2026-10-25T12:00:00+05:30') });
ok('   done late → day 1 stays, no escalation', JSON.stringify(amounts(r)) === '[25000]');
// honest close as missed stops doubling
r = run({ commitments: [staked({ status: 'missed', resolved_at: '2026-10-21T09:00:00+05:30' })], now: T('2026-10-25T12:00:00+05:30') });
ok('   honestly closed as missed → only ₹250', JSON.stringify(amounts(r)) === '[25000]');
// agreed after deadline / not staked → nothing
r = run({ commitments: [staked({ agreed_at: '2026-10-21T00:00:00+05:30' }), staked({ id: 'c2', staked: false })], now: T('2026-10-25T12:00:00+05:30') });
ok('   agreed after deadline / not staked → no penalty', r.entries.length === 0);
// 5 log inside grace
const lg = allLogs(days); lg[1].entries_seen.dinner = '2026-10-20T23:30:00+05:30';
r = run({ logs: lg, now: T('2026-10-21T02:00:00+05:30') });
ok('5 dinner logged 23:30 (inside 2h grace) → no fine', r.entries.length === 0);
// 6 missing after grace
const lg2 = allLogs(days); delete lg2[1].entries.dinner; delete lg2[1].entries_seen.dinner;
r = run({ logs: lg2, now: T('2026-10-21T02:00:00+05:30') });
ok('6 dinner missing after grace → one ₹100', JSON.stringify(amounts(r)) === '[10000]' && r.entries[0].incident_id === 'log:dinner:2026-10-20');
// logged on phone in time but synced late → review
const lg3 = allLogs(days); lg3[1].entries.dinner = '2026-10-20T21:00:00+05:30'; lg3[1].entries_seen.dinner = '2026-10-21T08:00:00+05:30';
r = run({ logs: lg3, now: T('2026-10-21T09:00:00+05:30') });
ok('14 phone logged in time, synced late → review, no fine', r.entries.length === 0 && r.incidents.find(i => i.id === 'log:dinner:2026-10-20').status === 'review');
// 7 overlap: same root already fined by another incident
r = run({ logs: lg2, incidents: [{ id: 'promise:x', root_key: 'log:dinner:2026-10-20', status: 'resolved' }], now: T('2026-10-21T02:00:00+05:30') });
ok('7 same omission already fined elsewhere → suppressed, ₹0', r.entries.length === 0 && r.incidents.find(i => i.id === 'log:dinner:2026-10-20').status === 'overlap_suppressed');
// 22 caps: day cap ₹1,000
const many = ['a', 'b', 'c', 'd', 'e'].map(id => staked({ id, deadline_at: '2026-10-20T23:00:00+05:30' }));
r = run({ commitments: many, now: T('2026-10-21T02:00:00+05:30') });
ok('22 five misses same day → day cap ₹1,000 total', amounts(r).reduce((a, b) => a + b, 0) === 100000, amounts(r));
// month cap
const prior = [{ incident_id: 'old', kind: 'assessment', local_date: '2026-10-10', amount_paise: 490000 }];
r = run({ commitments: [staked()], entries: prior, now: T('2026-10-21T02:00:00+05:30') });
ok('22 month cap: only ₹100 room left → trimmed to ₹100, capped', JSON.stringify(amounts(r)) === '[10000]' && r.entries[0].calc.trimmed_by_cap && r.incidents[0].status === 'capped');
// 23 policy change: commitments agreed before the policy are not assessed by it
r = run({ policy: Object.assign({}, P, { effective_from: '2026-10-20T00:00:00+05:30' }), commitments: [staked()], logs: allLogs(days), now: T('2026-10-25T12:00:00+05:30') });
ok('23 agreed before this policy → not assessed', r.entries.length === 0);
// logs before the policy started are not fined
r = run({ logs: [], now: T('2026-10-19T09:00:00+05:30') });
ok('   no fines for deadlines before the policy started', r.entries.length === 0);
// month boundary (IST): 31 Oct 23:00 deadline → checkpoint 1 Nov 01:00 IST → November
r = run({ commitments: [staked({ deadline_at: '2026-10-31T23:00:00+05:30' })], logs: allLogs(['2026-10-31', '2026-11-01']), now: T('2026-11-01T02:00:00+05:30') });
const pe = r.entries.find(e => e.incident_id === 'promise:c1');
ok('11 IST month boundary → entry dated 2026-11-01', pe && pe.local_date === '2026-11-01');
// every entry explains itself
ok('   every entry has calc + why + caps', r.entries.every(e => e.calc && e.calc.why && e.calc.caps && Number.isInteger(e.amount_paise)));

// ── Phase 2: gym / diet / sleep exceptions with monthly passes ──
{
  const { exceptionCandidates, exceptionExtras, bedMinutes } = require('../api/_penalty.js');
  const X = Object.assign({}, P, { effective_from: '2026-10-19T00:00:00+05:30' }); // Mon 19 Oct
  const now = T('2026-10-25T13:00:00+05:30'); // Sun noon
  const good = d => ({ day: d, gym_done: true, total_cal: 1700, junk_meals: 0, sleep_hours: 7.5, bedtime: '11:30 PM',
    entries: {}, entries_seen: { workout: d + 'T18:00:00+05:30' } });
  const week = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];
  const st = (c, cat, d) => (c.find(x => x.category === cat && x.date === d) || {}).state;
  let c = exceptionCandidates({ policy: X, logs: week.map(good), marks: [], uses: [], now });
  ok('P2 all good → every gym/diet/sleep day ok or pending', c.every(x => x.state === 'ok' || x.state === 'pending'));
  ok('P2 Sunday is not a gym day', !c.some(x => x.category === 'gym' && x.date === '2026-10-25'));
  const lg = week.map(good); lg[1].entries_seen = {}; lg[1].gym_done = false;           // Tue: no workout
  lg[2].junk_meals = 1;                                                                // Wed: junk meal
  lg[3].total_cal = 2600;                                                              // Thu: over calories
  lg[4].sleep_hours = 5;                                                               // Fri: short sleep
  lg[5].bedtime = '1:15 am';                                                           // Sat: late bedtime
  c = exceptionCandidates({ policy: X, logs: lg, marks: [], uses: [], now });
  ok('P2 missed gym day → needs a pass', st(c, 'gym', '2026-10-20') === 'needs_allowance');
  ok('P2 junk meal → diet exception', st(c, 'diet', '2026-10-21') === 'needs_allowance');
  ok('P2 2600 kcal → diet exception', st(c, 'diet', '2026-10-22') === 'needs_allowance');
  ok('P2 5h sleep → sleep exception', st(c, 'sleep', '2026-10-23') === 'needs_allowance');
  ok('P2 bed 1:15 am → sleep exception', st(c, 'sleep', '2026-10-24') === 'needs_allowance');
  const none = exceptionCandidates({ policy: X, logs: [], marks: [], uses: [], now });
  ok('P2 no data → no diet/sleep exception (missing ≠ violation)', none.filter(x => x.category !== 'gym').every(x => x.state === 'ok' || x.state === 'pending'));
  c = exceptionCandidates({ policy: X, logs: lg, marks: [{ date: '2026-10-20', habit: 'move', kind: 'recovery', reason: 'fever' }], uses: [], now });
  ok('12 recovery day (ill) → excused, no pass used', st(c, 'gym', '2026-10-20') === 'excused');
  c = exceptionCandidates({ policy: X, logs: lg, marks: [{ date: '2026-10-20', habit: 'move', kind: 'min' }], uses: [], now });
  ok('P2 minimum workout marked → counts as done', st(c, 'gym', '2026-10-20') === 'ok');
  const rec = ['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'].map(d => ({ date: d, habit: 'move', kind: 'recovery' }));
  c = exceptionCandidates({ policy: X, logs: lg, marks: rec, uses: [], now });
  ok('P2 4 recovery days in a week → review, not auto-excused', st(c, 'gym', '2026-10-20') === 'review');
  c = exceptionCandidates({ policy: X, logs: lg, marks: [], uses: [{ category: 'gym', day: '2026-10-20', kind: 'planned', status: 'used' }], now });
  ok('8 planned rest day → covered by its pass', st(c, 'gym', '2026-10-20') === 'covered');
  const lg2 = week.map(good); lg2[1].entries_seen = {}; lg2[1].entries = { workout: '2026-10-20T19:00:00+05:30' };
  c = exceptionCandidates({ policy: X, logs: lg2, marks: [], uses: [], now });
  ok('14 workout logged in time but synced late → review', st(c, 'gym', '2026-10-20') === 'review');
  // pass decisions → incidents / money
  c = exceptionCandidates({ policy: X, logs: lg, marks: [], uses: [], now });
  const idx = c.findIndex(x => x.category === 'gym' && x.date === '2026-10-20');
  let dec = []; dec[idx] = { allowance: { ok: true, used: 3 } };
  let ex = exceptionExtras(X, c, dec).find(e => e.incident.id === 'gym:2026-10-20');
  ok('8 pass available → status allowance, no money', ex && ex.incident.status === 'allowance' && !ex.want && ex.incident.detail.pass === '3/7');
  dec[idx] = { allowance: { ok: false, used: 7 } };
  ex = exceptionExtras(X, c, dec).find(e => e.incident.id === 'gym:2026-10-20');
  ok('P2 passes used up → ₹250 once', ex && ex.want && ex.want.raw === 25000 && /all 7 passes/.test(ex.want.why));
  const r = plan({ policy: X, commitments: [], logs: allLogs(week), entries: [], incidents: [], now, extra: [ex] });
  ok('P2 exception money goes through caps + ledger', r.entries.length === 1 && r.entries[0].incident_id === 'gym:2026-10-20' && r.entries[0].amount_paise === 25000 && /passes ran out/.test(r.entries[0].calc.formula));
  ok('P2 undecided pass → nothing written', exceptionExtras(X, c, []).every(e => e.incident.id !== 'gym:2026-10-20'));
  ok('P2 bedtime parser', bedMinutes('11:30 PM') === 1410 && bedMinutes('1:15 am') === 75 && bedMinutes('00:45') === 45 && bedMinutes('12 am') === 0 && bedMinutes('soon') === null);
}

// ── Phase 3: dispute outcomes ──
{
  const { disputeOutcome } = require('../api/_penalty.js');
  const ents = [{ id: 11, incident_id: 'promise:c1', kind: 'assessment', day_n: 1, local_date: '2026-10-21', amount_paise: 25000, policy_version: 1 },
                { id: 12, incident_id: 'promise:c1', kind: 'escalation', day_n: 2, local_date: '2026-10-22', amount_paise: 50000, policy_version: 1 }];
  const d = { id: 'dp1', prev_status: 'escalating' };
  let o = disputeOutcome({ recommendation: 'uphold', why: 'photo shows the deck was sent on time' }, d, ents, '2026-10-25');
  ok('16 upheld → reversal for every entry, originals untouched, excused, pass released', o.dispute === 'upheld' && o.incident === 'excused' && o.releasePass && o.reversals.length === 2 && o.reversals.every(r => r.amount_paise < 0 && r.reverses) && o.reversals[1].local_date === '2026-10-22');
  o = disputeOutcome({ recommendation: 'uphold', why: 'x' }, d, ents.concat([{ id: 13, incident_id: 'promise:c1', kind: 'reversal', reverses: 11, amount_paise: -25000, local_date: '2026-10-21' }]), '2026-10-25');
  ok('16 already-reversed entries are not reversed twice', o.reversals.length === 1 && o.reversals[0].reverses === 12);
  o = disputeOutcome({ recommendation: 'reject', why: 'no workout logged and photo is a menu' }, d, ents, '2026-10-25');
  ok('16 rejected → back to previous status, no money moved', o.dispute === 'rejected' && o.incident === 'escalating' && !o.reversals.length);
  o = disputeOutcome({ recommendation: 'need_more', why: 'send the gym entry screenshot' }, d, ents, '2026-10-25');
  ok('16 need more → stays disputed (fine paused)', o.dispute === 'need_more' && o.incident === 'disputed');
  o = disputeOutcome(null, d, ents, '2026-10-25');
  ok('16 review failed → stays disputed, nothing decided', o.dispute === 'open' && o.incident === 'disputed' && !o.reversals.length);
  o = disputeOutcome({ recommendation: 'uphold' }, d, ents, '2026-10-25');
  ok('16 uphold without a reason → not applied', o.dispute === 'open' && o.incident === 'disputed');
}

// ── Phase 4: weight milestone ──
{
  const { weightPlan, meanWindow, baselineOf, weightTrend, adherence, WEIGHT_RULES, addDays } = require('../api/_penalty.js');
  const W = (day, kg, ok = true, i = 0) => ({ id: 'w' + day + i, day, kg, fasted: ok, morning: ok, measured_at: day + 'T07:0' + i + ':00+05:30' });
  const goal = { id: 'g1', status: 'baseline', requested_at: '2026-11-01T10:00:00+05:30', rules: WEIGHT_RULES };
  let r = weightPlan({ goal, weighins: [W('2026-11-02', 90), W('2026-11-03', 91, false)], logs: [], entries: [], now: T('2026-11-04T12:00:00+05:30'), version: 1 });
  ok('W baseline waits for 3 fasted morning weigh-ins (non-fasted ignored)', !r.patch && r.info.baseline_have === 1);
  const base = [W('2026-11-02', 90), W('2026-11-03', 90.4), W('2026-11-04', 89.6)];
  r = weightPlan({ goal, weighins: base, logs: [], entries: [], now: T('2026-11-04T12:00:00+05:30'), version: 1 });
  ok('W baseline = average of first 3, 12 weeks from the 3rd', r.patch && r.patch.status === 'active' && r.patch.baseline_kg === 90 && r.patch.end_day === '2027-01-27' && r.patch.ext_end_day === '2027-02-17', r.patch);
  const active = Object.assign({}, goal, r.patch);
  const endWeek = d => [0, 2, 4].map(k => W(addDays(d, -k), 0));
  // achieved at 12 weeks
  let ws = base.concat(endWeek('2027-01-27').map(w => Object.assign(w, { kg: 79.8 })));
  r = weightPlan({ goal: active, weighins: ws, logs: [], entries: [], now: T('2027-01-28T09:00:00+05:30'), version: 1 });
  ok('W target hit on the 7-day average → achieved, no fine', r.patch && r.patch.status === 'achieved' && r.extras.length === 0);
  // one low reading doesn't count
  ws = base.concat([W('2027-01-27', 79), W('2027-01-25', 83, true, 1), W('2027-01-23', 83, true, 2)]);
  r = weightPlan({ goal: active, weighins: ws, logs: [], entries: [], now: T('2027-01-28T09:00:00+05:30'), version: 1 });
  ok('W one low reading is not enough (average 81.67 > 80)', r.patch && r.patch.status === 'extension');
  // missed initial: ₹500 proposed, waits 48h
  ws = base.concat(endWeek('2027-01-27').map(w => Object.assign(w, { kg: 84 })));
  r = weightPlan({ goal: active, weighins: ws, logs: [], entries: [], now: T('2027-01-28T09:00:00+05:30'), version: 1 });
  let x = r.extras[0];
  ok('W missed at 12 weeks → ₹500 proposed, review for 48h, extension', r.patch.status === 'extension' && x.incident.status === 'review' && x.incident.detail.proposed_paise === 50000 && !x.want && x.incident.detail.lost_kg === 6);
  r = weightPlan({ goal: Object.assign({}, active, { status: 'extension' }), weighins: ws, logs: [], entries: [], now: T('2027-01-30T01:00:00+05:30'), version: 1 });
  x = r.extras[0];
  ok('W after 48h without dispute → ₹500 assessed', x.want && x.want.raw === 50000 && x.incident.status === 'resolved');
  // no weigh-ins at the end → unknown, no money
  r = weightPlan({ goal: active, weighins: base, logs: [], entries: [], now: T('2027-02-05T09:00:00+05:30'), version: 1 });
  ok('W no weigh-in near the end → outcome unknown, no fine', r.extras[0].incident.detail.proposed_paise === null && !r.extras[0].want);
  // extension end, adherence paths
  const ext = Object.assign({}, active, { status: 'extension' });
  const ws2 = ws.concat(endWeek('2027-02-17').map(w => Object.assign(w, { kg: 82 })));
  const days = []; for (let d = '2026-11-04'; d <= '2027-02-17'; d = addDays(d, 1)) days.push(d);
  const logsAll = days.map(d => ({ day: d }));
  const after = T('2027-02-20T09:00:00+05:30');
  r = weightPlan({ goal: ext, weighins: ws2, logs: logsAll, entries: [], now: after, version: 1 });
  let e2 = r.extras.find(e => /extension/.test(e.incident.id));
  ok('W followed the plan but missed → ₹1,000 (and "plan needs review")', r.patch.status === 'missed' && e2.want && e2.want.raw === 100000 && /plan itself needs review/.test(e2.want.why));
  const fines = days.filter((_, i) => i % 2 === 0).map((d, i) => ({ incident_id: 'gym:' + d, amount_paise: 25000 }));
  r = weightPlan({ goal: ext, weighins: ws2, logs: logsAll, entries: fines, now: after, version: 1 });
  e2 = r.extras.find(e => /extension/.test(e.incident.id));
  ok('W plan not followed (fined on half the days) → ₹3,000 proposed, overlap disclosed', e2.want && e2.want.raw === 300000 && /already fined separately/.test(e2.incident.detail.overlap_note));
  r = weightPlan({ goal: ext, weighins: ws2, logs: logsAll.slice(0, 40), entries: [], now: after, version: 1 });
  e2 = r.extras.find(e => /extension/.test(e.incident.id));
  ok('21 W logs too sparse → adherence unknown, review only, no fine', !e2.want && e2.incident.detail.adherence.status === 'unknown' && e2.incident.detail.proposed_paise === null);
  // fast loss safety
  const tr = weightTrend([W('2026-11-10', 90), W('2026-11-17', 88.8)], '2026-11-17', WEIGHT_RULES);
  ok('W losing >1%/week → safety flag', tr.fast && tr.pct_week > 1, tr);
  ok('W corrections: superseded weigh-in ignored', meanWindow([W('2026-11-10', 95), Object.assign(W('2026-11-10', 90, true, 1), { supersedes: 'w2026-11-100' })], '2026-11-10') === 90);
}
