// Server Head Coach huddle (api/_huddle.js): fixed conflict ladder, priority
// only from the plan, once per day, packet + planner + endpoint + cron.
const H = require('../api/_huddle.js');
const { buildPacket } = require('../api/_context.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''));

let r = H.resolve([{ between: ['fitness', 'mind'], a_wants: 'train through it', b_wants: 'rest, he has a knee pain', a_category: 'primary_goal', b_category: 'safety', issue: 'knee pain' }]);
ok('1 safety beats the primary goal', r[0].winner === 'mind' && /safety/.test(r[0].rule) && !r[0].needs_jeet, r);
r = H.resolve([{ between: ['nutrition', 'style'], a_category: 'primary_goal', b_category: 'preference', a_wants: 'no cheat meal', b_wants: 'party dinner', issue: 'x' }]);
ok('2 primary goal beats a preference', r[0].winner === 'nutrition');
r = H.resolve([{ between: ['fitness', 'sleep'], a_category: 'sleep', b_category: 'sleep', issue: 'late gym vs bedtime' }]);
ok('3 same level → not decided by AI, goes to Jeet', r[0].winner === null && r[0].needs_jeet === true);
r = H.resolve([{ between: ['fitness', 'hacker'], a_category: 'safety', b_category: 'preference' }, { between: ['fitness', 'sleep'], a_category: 'bogus', b_category: 'sleep' }]);
ok('4 unknown coaches dropped; unknown category → Jeet decides', r.length === 1 && r[0].needs_jeet === true, r);

const plan = { top3: [{ title: 'Gym at 10:00 PM (45 min)' }, { title: 'Send leg video' }] };
let f = H.finalize({ priority: 'Run a marathon today', focus: 'x', notes: [{ to: 'fitness', text: 'Keep it light, he slept 5h' }, { to: 'evil', text: 'y' }] }, { plan, day: '2026-12-01' });
ok('5 invented priority rejected → plan item 1', f.priority === 'Gym at 10:00 PM (45 min)' && f.notes.priority_from === 'plan');
f = H.finalize({ priority: 'send LEG video' }, { plan, day: '2026-12-01' });
ok('6 matching plan item kept (case/punctuation-insensitive)', f.priority === 'Send leg video' && f.notes.priority_from === 'huddle');
f = H.finalize({ priority: 'something else' }, { plan, day: '2026-12-01', morningPriority: 'Finish assignment' });
ok('7 his own morning priority beats a made-up one', f.priority === 'Finish assignment' && f.notes.priority_from === 'his morning check-in');
f = H.finalize({ notes: [{ to: 'fitness', text: 'Keep it light' }, { to: 'evil', text: 'nope' }] }, { plan, day: 'd' });
ok('8 notes only to real coaches', f.notes.list.length === 1 && f.notes.list[0].to === 'fitness');

(async () => {
  let rec = await H.runHuddle({ packet: 'P', pending: [], plan, day: '2026-12-01', callClaude: async () => { throw new Error('down'); } });
  ok('9 Claude down → still a huddle from the plan (marked not-AI)', rec.priority === 'Gym at 10:00 PM (45 min)' && rec.notes.ai === false);
  let sys = '';
  rec = await H.runHuddle({ packet: 'TEAM CONTEXT X', pending: [{ coach: 'nutrition', change: 'Dinner by 10 PM' }], plan, day: 'd', callClaude: async (s) => { sys = s; return 'here: {"focus":"Sleep first","priority":"Send leg video","conflicts":[],"notes":[]}'; } });
  ok('10 prompt has the packet, plan and pending proposals; JSON pulled out of text', /TEAM CONTEXT X/.test(sys) && /Send leg video/.test(sys) && /Dinner by 10 PM/.test(sys) && rec.focus === 'Sleep first' && rec.notes.ai === true);

  // ensureHuddle: once per day
  const db = { huddles: [], notes: [] }; let calls = 0;
  const q = async p => (p.startsWith('jeetos_huddles') ? db.huddles : []);
  const write = async (p, body) => { if (p.startsWith('jeetos_huddles')) { if (db.huddles.length) return { ok: true, status: 200, body: [] }; db.huddles.push(body); return { ok: true, status: 201, body: [body] }; } db.notes.push(...body); return { ok: true, status: 201, body: null }; };
  const cc = async () => { calls++; return '{"focus":"Gym tonight","priority":"x","conflicts":[{"between":["fitness","sleep"],"a_category":"primary_goal","b_category":"sleep","a_wants":"gym 10 PM","b_wants":"bed by 12:30","issue":"late gym"}],"notes":[{"to":"sleep","text":"Remind him lights out 12:30"}]}'; };
  const NOW = Date.parse('2026-12-01T07:40:00+05:30');
  let out = await H.ensureHuddle({ q, write, callClaude: cc, now: NOW, source: 'cron' });
  ok('11 first run creates the huddle + coach notes from head', out.created && db.huddles.length === 1 && db.notes[0].from_coach === 'head' && db.notes[0].to_coach === 'sleep' && db.huddles[0].source === 'cron');
  ok('12 conflict resolved by rule (primary goal > sleep extras)', db.huddles[0].conflicts[0].winner === 'fitness' && /primary goal/.test(db.huddles[0].conflicts[0].rule));
  out = await H.ensureHuddle({ q, write, callClaude: cc, now: NOW, source: 'app' });
  ok('13 second run is a no-op (no second Claude call)', !out.created && calls === 1 && db.huddles.length === 1);

  // Packet + planner
  const raw = { huddle: { day: '2026-12-01', focus: 'Gym tonight', priority: 'Send leg video', conflicts: db.huddles[0].conflicts } };
  const pk = buildPacket(raw, { coach: 'sleep', now: Date.parse('2026-12-01T10:00:00+05:30') });
  ok('14 every coach sees the huddle + the rule used', /HEAD COACH HUDDLE TODAY/.test(pk.text) && /focus: Gym tonight/.test(pk.text) && /rule: the primary goal comes before department wishes/.test(pk.text));
  ok('15 huddle priority feeds the plan when nothing else is set', pk.plan.top3.some(t => t.title === 'Send leg video'), pk.plan.top3);
  const old = buildPacket({ huddle: { day: '2026-11-30', focus: 'stale' } }, { coach: 'sleep', now: Date.parse('2026-12-01T10:00:00+05:30') });
  ok('16 yesterday\'s huddle is not shown today', !/stale/.test(old.text));

  // Endpoint
  const osPath = require('path').join(__dirname, '../api/os.js');
  process.env.ANTHROPIC_API_KEY = 'x';
  const st = { huddles: [], notes: [] };
  global.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url)); const j = (b, s2 = 200) => ({ ok: s2 < 300, status: s2, json: async () => b });
    if (u.includes('rpc/jeetos_is_owner')) return j(true);
    if (u.includes('api.anthropic.com')) return j({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"focus":"Rest today","priority":"","conflicts":[],"notes":[]}' }] });
    if (u.includes('jeetos_huddles') && init.method === 'POST') { const b = JSON.parse(init.body); if (st.huddles.length) return j([]); st.huddles.push(b); return j([b], 201); }
    if (u.includes('jeetos_huddles')) return j(st.huddles);
    if (u.includes('jeetos_coach_notes') && init.method === 'POST') { st.notes.push(...JSON.parse(init.body)); return j(null, 201); }
    return j([]);
  };
  delete require.cache[osPath]; delete require.cache[require.resolve('../api/_auth.js')];
  const os = require(osPath), call = req => new Promise(res => os(Object.assign({ headers: { authorization: 'Bearer h.p.s' }, query: {} }, req), { status: c => ({ json: b => res({ code: c, body: b }) }) }));
  let x = await call({ method: 'GET', query: { action: 'huddle' } });
  ok('17 GET before it runs → null', x.code === 200 && x.body.huddle === null);
  x = await call({ method: 'POST', body: { action: 'huddle.run' } });
  ok('18 POST huddle.run creates today\'s huddle (source app)', x.code === 200 && x.body.created && st.huddles[0].source === 'app' && st.huddles[0].focus === 'Rest today');
  x = await call({ method: 'POST', body: { action: 'huddle.run' } });
  ok('19 running again returns the same one', x.code === 200 && !x.body.created && st.huddles.length === 1);
})();
