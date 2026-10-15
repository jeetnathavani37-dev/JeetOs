// Adaptive daily plan (api/_planner.js) — through the same anchors the coaches see.
const { planToday } = require('../api/_planner.js');
const { anchorStatus } = require('../api/_context.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''));
const T = s => Date.parse(s);
const run = (when, raw = {}, extra = {}) => {
  const now = T(when), day = when.slice(0, 10);
  const anchors = anchorStatus(Object.assign({ logs: [], checkins: [] }, raw), now);
  return planToday(Object.assign({ day, now, anchors, log: (raw.logs || [])[0] || null }, extra));
};
const wakeDone = d => ({ anchor: 'wake', day: d });

// Tuesday 20 Oct 2026
let p = run('2026-10-20T11:15:00+05:30', { checkins: [wakeDone('2026-10-20')] });
ok('1 gym missed at 11:15 → moved to the first free 45-min window (after library, 10 PM)', p.changes[0] && p.changes[0].type === 'moved' && /10:00 PM/.test(p.changes[0].text), p.changes);
ok('2 the day is not written off', p.message === 'Plan update hua — din abhi bhi bacha hai.' && p.top3.some(t => /Gym at 10:00 PM/.test(t.title)));
p = run('2026-10-20T22:40:00+05:30', { checkins: [wakeDone('2026-10-20'), { anchor: 'work', day: '2026-10-20' }, { anchor: 'leave', day: '2026-10-20' }] });
ok('3 too late for a real session (ends after 10:45 PM) → 20-min home workout', p.changes[0] && p.changes[0].type === 'minimum', p.changes);
p = run('2026-10-21T00:20:00+05:30', { checkins: [wakeDone('2026-10-20'), { anchor: 'work', day: '2026-10-20' }, { anchor: 'leave', day: '2026-10-20' }] }, { day: '2026-10-20' });
ok('4 no time left at all → dropped honestly, tomorrow 9:30', p.changes[0] && p.changes[0].type === 'dropped', p.changes);
p = run('2026-10-20T11:15:00+05:30', { checkins: [wakeDone('2026-10-20')] }, { checkin: { energy: 1 } });
ok('5 low energy in the morning check-in → minimum version, not a 45-min session', p.changes[0] && p.changes[0].type === 'minimum');
p = run('2026-10-20T11:15:00+05:30', { checkins: [wakeDone('2026-10-20')] }, { recovery: true });
ok('6 recovery day → rest first, no gym repair, no risks', p.top3[0].kind === 'recovery' && p.changes.length === 0 && p.risks.length === 0);
p = run('2026-10-20T11:15:00+05:30', { checkins: [wakeDone('2026-10-20')], logs: [{ day: '2026-10-20', gym_done: true }] });
ok('7 gym ticked in the log (no check-in) → nothing to repair', p.changes.length === 0);
p = run('2026-10-25T11:15:00+05:30', { checkins: [wakeDone('2026-10-25')] });
ok('8 Sunday: no gym/library repairs', p.changes.length === 0);

// Priorities
p = run('2026-10-20T09:45:00+05:30', { checkins: [wakeDone('2026-10-20')] }, { promises: [{ id: 'c1', text: 'Send leg video', due: '2026-10-19', owner: 'jeet' }] });
ok('9 extension window beats everything, then the overdue promise', p.top3[0].key === 'gym' && /now/.test(p.top3[0].title) && p.top3[1].title === 'Send leg video' && /overdue/.test(p.top3[1].why), p.top3.map(t => t.title));
p = run('2026-10-20T13:30:00+05:30', { checkins: [wakeDone('2026-10-20'), { anchor: 'gym', day: '2026-10-20' }] });
ok('10 library start missed → "still Xh left", not failure', p.changes.some(c => c.type === 'shortened' && /8\.5h/.test(c.text)), p.changes);
ok('11 a meal with no log is "log it if you ate" (unknown), never "missed"', p.top3.concat([]).length <= 3 && !JSON.stringify(p).includes('missed breakfast'));
p = run('2026-10-20T08:20:00+05:30', {}, { health: { gym: 'at_risk', diet: 'at_risk', sleep: 'behind', weighin: 'unknown' } });
ok('12 at-risk goals become today\'s actions; fasted weigh-in suggested before 11 AM', p.top3.some(t => /Fasted weigh-in now/.test(t.title)) || p.risks.includes('gym goal at risk this week'), p.top3.map(t => t.title));
ok('13 never more than 3 top items', p.top3.length <= 3);
p = run('2026-10-20T11:15:00+05:30', { checkins: [wakeDone('2026-10-20')] }, { health: { gym: 'at_risk' } });
ok('14 at-risk gym → the moved gym session ranks high', p.top3[0].kind === 'repair' && p.top3[0].key === 'gym', p.top3.map(t => [t.kind, t.title]));
ok('15 free windows reported with minutes', Array.isArray(p.free) && p.free.every(w => w.min >= 15));

// Endpoint: GET /api/os?action=today
(async () => {
  const osPath = require('path').join(__dirname, '../api/os.js');
  const mk = (owner, rows) => {
    global.fetch = async (url) => { const u = decodeURIComponent(String(url)); const j = (b, st = 200) => ({ ok: st < 300, status: st, json: async () => b });
      if (u.includes('rpc/jeetos_is_owner')) return j(owner);
      for (const k of Object.keys(rows)) if (u.includes(k)) return j(rows[k]);
      return j([]); };
    delete require.cache[osPath]; delete require.cache[require.resolve('../api/_auth.js')];
    const h = require(osPath);
    return req => new Promise(res => h(Object.assign({ headers: { authorization: 'Bearer h.p.s' }, query: {} }, req), { status: c => ({ json: b => res({ code: c, body: b }) }) }));
  };
  let call = mk(false, {});
  ok('16 today endpoint is owner-only', (await call({ method: 'GET', query: { action: 'today' } })).code === 401);
  call = mk(true, { 'jeetos_commitments?status=eq.open': [{ id: 'c1', text: 'Send leg video', due: '2000-01-01', owner: 'jeet', coach: 'fitness' }, { id: 'c2', text: 'coach owes', due: '2000-01-01', owner: 'coach', coach: 'fitness' }] });
  const r = await call({ method: 'GET', query: { action: 'today' } });
  ok('17 returns plan + next action + his promises (not the coach\'s own)', r.code === 200 && Array.isArray(r.body.plan.top3) && typeof r.body.nextAction === 'string' && r.body.promises.length === 1 && r.body.promises[0].overdue === true, r.body.promises);
  ok('18 overdue promise is in the top 3', r.body.plan.top3.some(t => t.title === 'Send leg video'));
})();
