// Approval Centre (api/_approvals.js + GET /api/os?action=approvals): one list of
// everything waiting on Jeet, consequential first, each with the exact action that applies it.
const A = require('../api/_approvals.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''));
const TODAY = '2026-11-20';

let r = A.collect({}, TODAY);
ok('1 nothing pending → empty list', r.count === 0 && r.items.length === 0);

const src = {
  goalProposal: [{ id: 'p', kind: 'primary', title: 'Lose 10 kg' }, { id: 'diet', kind: 'supporting', title: 'Diet' }],
  repairs: [{ id: 'shift:gym:10:15', text: 'Gym: 4 of 6 days late. Move to 10:15?', effect: 'Applies from tomorrow.' }],
  pendingDecisions: [{ id: 'd1', coach: 'fitness', change: 'Gym 5x a week', reason: 'faster loss', created_at: '2026-11-10T10:00:00Z' }],
  memories: [
    { id: 'm1', text: 'Works at the library 2–10', status: 'active', pending: 'retract', pending_reason: 'he said 12:30 now', updated_at: '2026-11-19T00:00:00Z' },
    { id: 'm2', text: 'Probably lactose intolerant', status: 'unconfirmed', coach: 'nutrition', observed_at: '2026-11-18T00:00:00Z' },
    { id: 'm3', text: 'Feels anxious before exams', status: 'unconfirmed', scope: 'private:mind', observed_at: '2026-11-18T00:00:00Z' },
    { id: 'm4', text: 'Uses CeraVe cleanser', status: 'active', review_after: '2026-11-01', observed_at: '2026-08-01T00:00:00Z' },
    { id: 'm5', text: 'Fresh fact', status: 'active', review_after: '2027-03-01' },
  ],
  journal: [
    { id: 'j1', status: 'approved', change: 'Sleep by 12:30', decided_at: '2026-11-01T00:00:00Z', expected_outcome: '7h sleep' },
    { id: 'j2', status: 'approved', change: 'Later', decided_at: '2026-11-15T00:00:00Z' },
    { id: 'j3', status: 'approved', change: 'Reviewed', decided_at: '2026-10-01T00:00:00Z', verdict: 'worked' },
  ],
};
r = A.collect(src, TODAY);
const types = r.items.map(i => i.type);
ok('2 most consequential first: goal plan, schedule, coach plan change, then facts and reviews', JSON.stringify(types) === JSON.stringify(['goal_plan', 'schedule', 'plan_change', 'memory_retract', 'memory_confirm', 'journal_review', 'memory_stale']), types);
ok('3 every item has its exact action(s)', r.items.every(i => i.actions.length >= 1 && i.actions.every(a => a.op && (a.op.action || a.op.client))));
ok('4 server actions are all on the allow-list', r.items.every(i => i.actions.every(a => a.op.client || A.ALLOWED.has(a.op.action))));
ok('5 coach plan change is decided in the app (master plan stays in sync)', r.items.find(i => i.type === 'plan_change').actions[0].op.client === 'decide');
ok('6 mind-coach private facts never show here', !r.items.some(i => /anxious/.test(i.title)));
ok('7 retract proposal: remove vs still true, with the reason', (() => { const i = r.items.find(i => i.type === 'memory_retract'); return i.detail === 'he said 12:30 now' && i.actions.map(a => a.op.op).join() === 'retract,keep'; })());
ok('8 guessed fact names who guessed it', /nutrition guessed this/.test(r.items.find(i => i.type === 'memory_confirm').detail));
ok('9 journal: only due (14 days default) and not yet reviewed', r.items.filter(i => i.type === 'journal_review').map(i => i.id).join() === 'j1');
ok('10 stale facts (review date passed) asked "still true?"; fresh ones not', r.items.some(i => i.type === 'memory_stale' && i.id === 'm4') && !r.items.some(i => i.id === 'm5'));
ok('11 age in days shown', r.items.find(i => i.id === 'd1').age_days === 10);
ok('12 counts by type', r.count === 7 && r.by_type.memory_confirm === 1);

(async () => {
  const osPath = require('path').join(__dirname, '../api/os.js');
  let failMem = false;
  global.fetch = async (url) => {
    const u = decodeURIComponent(String(url)); const j = (b, st = 200) => ({ ok: st < 300, status: st, json: async () => b });
    if (u.includes('rpc/jeetos_is_owner')) return j(true);
    if (u.includes('jeetos_decisions?status=eq.pending')) return j(src.pendingDecisions);
    if (u.includes('jeetos_memories?status=in.(active,unconfirmed)&select=id,text,scope')) return failMem ? j({}, 401) : j(src.memories);
    if (u.includes('jeetos_goals?status=eq.active')) return j([]);
    return j([]);
  };
  delete require.cache[osPath]; delete require.cache[require.resolve('../api/_auth.js')];
  const os = require(osPath), call = req => new Promise(res => os(Object.assign({ headers: { authorization: 'Bearer h.p.s' }, query: {} }, req), { status: c => ({ json: b => res({ code: c, body: b }) }) }));
  let x = await call({ method: 'GET', query: { action: 'approvals' } });
  ok('13 endpoint: goal plan proposed when no primary goal exists, plus coach change + facts', x.code === 200 && x.body.items[0].type === 'goal_plan' && x.body.items.some(i => i.key === 'plan_change:d1') && x.body.items.some(i => i.type === 'memory_retract'), x.body.items.map(i => i.key));
  failMem = true;
  x = await call({ method: 'GET', query: { action: 'approvals' } });
  ok('14 unreadable memories → reported, not silently "nothing pending"', x.code === 200 && x.body.unreadable.includes('memories') && !x.body.items.some(i => /^memory/.test(i.type)));
})();
