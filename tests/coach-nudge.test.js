// api/coach-nudge.js uses the shared context engine: the cron coach sees the
// same team packet as the chat (schedule, goals, promises, memory, unknowns).
const path = require('path').join(__dirname, '../api/coach-nudge.js');
process.env.ANTHROPIC_API_KEY = 'x';
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 260) : ''));

function run(query, now, rows) {
  let system = null; const inserted = [], asked = [];
  const RealNow = Date.now; Date.now = () => now;
  global.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url));
    asked.push(u);
    const j = (b, st = 200) => ({ ok: st < 300, status: st, json: async () => b, text: async () => JSON.stringify(b) });
    if (u.includes('api.anthropic.com')) { system = JSON.parse(init.body).system; return j({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Chal bhai, uth ja!' }] }); }
    if (u.includes('jeetos_coach_inbox?on_conflict')) { inserted.push(JSON.parse(init.body)); return j([{ id: 1 }], 201); }
    for (const k of Object.keys(rows)) if (u.includes(k)) return j(rows[k]);
    return j([]);
  };
  delete require.cache[path];
  const h = require(path);
  return new Promise(res => h({ headers: {}, query }, { status: c => ({ json: b => { Date.now = RealNow; res({ code: c, body: b, system, inserted, asked }); } }) }));
}

(async () => {
  const rows = {
    'jeetos_team_memory?': [{ fact: 'Newest fact: exams till 30 Oct', from_coach: 'mind', created_on: '2026-10-19' }],
    'jeetos_coach_goals?status=eq.active&select=id': [{ id: 'g1', coach: 'fitness', text: 'Bench 60 kg', unit: 'kg', start_value: 40, target: 60, current_value: 45, deadline: '2026-12-31', history: [], created_at: '2026-09-01T00:00:00Z' }],
    'jeetos_goal_state?': [{ data: { goalId: 'g1' } }],
    'jeetos_anchor_checkins?day=in.': [],
    'jeetos_penalty_incidents?': [{ id: 'i1', category: 'anchor', title: 'Lunch late', status: 'assessed', updated_at: '2026-10-19T10:00:00Z' }],
  };
  // 8:10 AM Tuesday, wake not checked in → Dr. Sam's alarm ping.
  const r = await run({ slot: 'anchor', anchor: 'wake' }, Date.parse('2026-10-20T08:10:00+05:30'), rows);
  ok('1 alarm ping still sent from Dr. Sam', r.inserted[0] && r.inserted[0].coach === 'sleep' && r.inserted[0].slot === 'a_wake', r.inserted);
  ok('2 prompt carries the shared team context packet', /=== TEAM CONTEXT for Dr\. Sam/.test(r.system || ''));
  ok('3 packet has primary goal, schedule state and next action', /"Bench 60 kg"/.test(r.system) && /8:00 AM Wake up: in extension/.test(r.system) && /\[NEXT ACTION\]/.test(r.system));
  ok('4 newest memory reaches the cron coach (desc order)', /Newest fact: exams till 30 Oct/.test(r.system) && r.asked.some(u => u.includes('jeetos_team_memory') && u.includes('order=created_at.desc')));
  ok('5 sleep coach never sees the ledger', !/LEDGER|Lunch late/.test(r.system));
  ok('6 missing data framed as unknown', /never treat it as failure/.test(r.system) && /ask, never accuse/.test(r.system));
  ok('7 no oldest-first memory read anywhere', !r.asked.some(u => u.includes('jeetos_team_memory') && u.includes('order=created_at.asc')));
})();
