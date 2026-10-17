// Focus Mode (api/_focus.js + notify/push + context + /api/os): one session at a time,
// nudges held (alarms still come), coaches told to keep it short, unknown ≠ done.
const F = require('../api/_focus.js');
const { decide } = require('../api/_notify.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''));
const T0 = Date.parse('2026-11-20T14:00:00+05:30');

let s = F.start({ task: '  Polity chapter 4 <b>notes</b> ', minutes: 50 }, [], T0);
ok('1 start: task cleaned, end time set, IST day', s.row.task === 'Polity chapter 4 notes' && s.row.planned_min === 50 && s.row.ends_at === new Date(T0 + 50 * 60000).toISOString() && s.row.day === '2026-11-20' && s.row.status === 'active');
ok('2 length 10–180', /10–180/.test(F.start({ task: 'x y', minutes: 5 }, [], T0).error) && /10–180/.test(F.start({ task: 'x y', minutes: 300 }, [], T0).error));
ok('3 task required', !!F.start({ task: '', minutes: 30 }, [], T0).error);
ok('4 one at a time', /already running/.test(F.start({ task: 'abc', minutes: 30 }, [s.row], T0 + 60000).error));
ok('5 after 1 AM still counts as the previous day', F.start({ task: 'late', minutes: 30 }, [], Date.parse('2026-11-21T01:30:00+05:30')).row.day === '2026-11-20');

const a = s.row;
ok('6 running until end + 30 min grace', F.activeOf([a], T0 + 70 * 60000) === a && F.activeOf([a], T0 + 81 * 60000) === null);
let e = F.end(a, 'done', 'all 3 topics', T0 + 45 * 60000);
ok('7 end done → actual minutes spent, note kept', e.patch.status === 'done' && e.patch.actual_min === 45 && e.patch.note === 'all 3 topics');
e = F.end(a, 'abandoned', '', T0 + 200 * 60000);
ok('8 actual time capped at plan + grace', e.patch.actual_min === 80 && e.patch.note === null);
ok('9 bad outcome refused', !!F.end(a, 'kinda', '', T0).error);
const ex = F.expirePatches([a], T0 + 90 * 60000);
ok('10 never closed → "expired", actual time unknown', ex.length === 1 && ex[0].patch.status === 'expired' && ex[0].patch.actual_min === null);

const sessions = [
  { day: '2026-11-20', status: 'done', actual_min: 50 }, { day: '2026-11-20', status: 'abandoned', actual_min: 10 },
  { day: '2026-11-18', status: 'done', actual_min: 90 }, { day: '2026-11-15', status: 'expired', actual_min: null },
  { day: '2026-11-01', status: 'done', actual_min: 100 }, { day: '2026-11-20', status: 'active' },
];
const st = F.stats(sessions, '2026-11-20');
ok('11 stats: today & 7-day minutes, expired not counted as done or given up', st.today_min === 60 && st.today_sessions === 2 && st.week_min === 150 && st.week_sessions === 4 && st.week_done_pct === 67 && st.week_judged === 3 && st.week_expired === 1, st);
ok('12 completion % only with 3+ judged sessions', F.stats(sessions.slice(0, 2), '2026-11-20').week_done_pct === null);

// notifications
const ends = T0 + 50 * 60000;
ok('13 nudge held during focus (with the end time)', (() => { const d = decide({ tag: 'fitness-evening', now: T0 + 60000, sentToday: [], focusUntil: ends }); return !d.ok && /focus mode until 14:50 IST/.test(d.reason); })());
ok('14 his schedule alarm still comes through', decide({ tag: 'fitness-a_gym', now: T0 + 60000, sentToday: [], focusUntil: ends }).ok);
ok('15 deadline still comes through', decide({ tag: 'settle-2026-11-20', now: T0 + 60000, sentToday: [], focusUntil: ends }).ok);
ok('16 after focus ends, nudges flow again', decide({ tag: 'fitness-evening', now: ends + 60000, sentToday: [], focusUntil: ends }).ok);

// context
const C = require('../api/_context.js');
const pk = C.buildPacket({ focus: [a] }, { coach: 'fitness', now: T0 + 10 * 60000 });
ok('17 coaches see FOCUS MODE first with minutes left', /\[FOCUS MODE\]\n- In focus on "Polity chapter 4 notes" until 2:50 PM \(40 min left\)\. Keep replies to 1-2 lines/.test(pk.text) && pk.text.indexOf('FOCUS MODE') < pk.text.indexOf('[NOW'), pk.text.slice(0, 300));
ok('18 no focus line once it is over', !/FOCUS MODE/.test(C.buildPacket({ focus: [a] }, { coach: 'fitness', now: T0 + 90 * 60000 }).text));

(async () => {
  // push: focus session read from the DB holds a nudge
  process.env.VAPID_SEED = process.env.VAPID_SEED || 'test-seed-for-focus';
  const { sendToAll } = require('../api/_push.js');
  const logged = [];
  const supa = async (p, init) => { const j = b => ({ ok: true, status: 200, json: async () => b });
    if (p.startsWith('jeetos_focus_sessions')) return j([{ ends_at: new Date(Date.now() + 20 * 60000).toISOString() }]);
    if (p.startsWith('jeetos_push_log') && init && init.method === 'POST') { logged.push(JSON.parse(init.body)); return j(null); }
    return j([]); };
  const r = await sendToAll(supa, { title: 'x', body: 'y', tag: 'fitness-evening' });
  ok('19 push: nudge held and logged as "focus mode"', r.sent === 0 && /^focus mode/.test(r.held || '') && logged[0] && logged[0].decision === 'held', r);

  // endpoint
  const osPath = require('path').join(__dirname, '../api/os.js');
  const rows = [];
  global.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url)); const j = (b, st = 200) => ({ ok: st < 300, status: st, json: async () => b });
    if (u.includes('rpc/jeetos_is_owner')) return j(true);
    if (u.includes('/jeetos_focus_sessions') && init.method === 'POST') { const x = JSON.parse(init.body); if (rows.some(r => r.status === 'active')) return j({}, 409); rows.unshift(x); return j([x], 201); }
    if (u.includes('/jeetos_focus_sessions') && init.method === 'PATCH') { const id = /id=eq\.([^&]+)/.exec(u)[1], r = rows.find(r => r.id === id && r.status === 'active'); if (!r) return j([]); Object.assign(r, JSON.parse(init.body)); return j([r]); }
    if (u.includes('/jeetos_focus_sessions')) return j(rows.slice());
    return j([]);
  };
  delete require.cache[osPath]; delete require.cache[require.resolve('../api/_auth.js')];
  const os = require(osPath), call = req => new Promise(res => os(Object.assign({ headers: { authorization: 'Bearer h.p.s' }, query: {} }, req), { status: c => ({ json: b => res({ code: c, body: b }) }) }));
  const RealNow = Date.now;
  Date.now = () => T0;
  let x = await call({ method: 'POST', body: { action: 'focus.start', task: 'Polity notes', minutes: 50 } });
  ok('20 POST start → stored', x.code === 200 && rows[0].status === 'active');
  x = await call({ method: 'POST', body: { action: 'focus.start', task: 'Another', minutes: 25 } });
  ok('21 second start refused', x.code === 400);
  Date.now = () => T0 + 30 * 60000;
  x = await call({ method: 'GET', query: { action: 'focus' } });
  ok('22 GET → running session', x.code === 200 && x.body.active && x.body.active.task === 'Polity notes');
  x = await call({ method: 'POST', body: { action: 'focus.end', id: rows[0].id, outcome: 'done' } });
  ok('23 end done → 30 min recorded', x.code === 200 && rows[0].status === 'done' && rows[0].actual_min === 30);
  Date.now = () => T0 + 60 * 60000;
  await call({ method: 'POST', body: { action: 'focus.start', task: 'Forgot to close', minutes: 25 } });
  Date.now = () => T0 + 200 * 60000;
  x = await call({ method: 'GET', query: { action: 'focus' } });
  ok('24 a session never closed is marked expired on the next look', x.body.active === null && rows[0].status === 'expired' && x.body.stats.today_min === 30, x.body.stats);
  Date.now = RealNow;
})();
