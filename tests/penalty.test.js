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
