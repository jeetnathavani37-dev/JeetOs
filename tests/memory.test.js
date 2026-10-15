// Memory v2: rules (api/_memory.js), the endpoint (api/os.js) against an
// in-memory table, and what reaches the coaches (api/_context.js).
const M = require('../api/_memory.js');
const { buildPacket } = require('../api/_context.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 260) : ''));
const NOW = '2026-10-20T10:00:00.000Z';

// ── Rules ──
let r = M.classify({ text: 'Has exams till 30 Oct', section: 'routine' }, { coach: 'fitness', source: 'tag', now: NOW });
ok('1 a coach note of what he said → active, med, jeet_said, dated review', r.status === 'active' && r.confidence === 'med' && r.source_type === 'jeet_said' && r.kind === 'constraint' && r.review_after === '2026-12-19', r);
r = M.classify({ text: 'Lagta hai he skips breakfast when stressed' }, { coach: 'nutrition', source: 'tag', now: NOW });
ok('2 a coach guess → unconfirmed, low, coach_inferred', r.status === 'unconfirmed' && r.confidence === 'low' && r.source_type === 'coach_inferred', r);
r = M.classify({ text: 'Feels anxious before exams' }, { coach: 'mind', source: 'tag', now: NOW });
ok('3 mind coach memory stays private', r.scope === 'private:mind');
r = M.classify({ text: 'Wants abs by March' }, { source: 'user', now: NOW });
ok('4 Jeet adding it himself → high, jeet_confirmed', r.confidence === 'high' && r.source_type === 'jeet_confirmed' && r.scope === 'team');
ok('5 secrets / account numbers / crisis details never stored', [ 'His password is hunter2', 'Card 4111111111111111', 'talked about self-harm', 'api key sk-ant-abc123' ].every(t => M.classify({ text: t }, { source: 'tag', now: NOW }) === null));
ok('6 tags stripped, length capped', M.classify({ text: '<b>Likes</b> paneer ' + 'x'.repeat(400) }, { source: 'tag', now: NOW }).text.length === 300);

const live = [
  { id: 'a', text: 'Gym after 6 pm', norm: M.norm('Gym after 6 pm'), scope: 'team' },
  { id: 'b', text: 'Vegetarian', norm: 'vegetarian', scope: 'team' },
  { id: 'p', text: 'Fear of failing', norm: M.norm('Fear of failing'), scope: 'private:mind' },
];
let plan = M.planPropose(live, [{ text: 'gym after 6 PM!' }], { coach: 'fitness', source: 'tag', now: NOW });
ok('7 duplicate (case/punctuation) is not re-added', plan.inserts.length === 0 && plan.events.length === 0);
plan = M.planPropose(live, [{ text: 'Gym at 9:30 am now', replaces: 'Gym after 6 pm', section: 'routine' }], { coach: 'fitness', source: 'memory_pass', now: NOW });
ok('8 changed fact supersedes the old one (kept, linked)', plan.inserts[0].supersedes === 'a' && plan.updates[0].id === 'a' && plan.updates[0].patch.status === 'superseded' && plan.updates[0].patch.superseded_by === plan.inserts[0].id && plan.updates[0].after === plan.inserts[0].id);
ok('9 supersede + create both audited', plan.events.map(e => e.action).sort().join() === 'create,supersede');
plan = M.planPropose(live, [{ text: 'Vegetarian', remove: true, reason: 'he said he eats eggs now' }], { coach: 'nutrition', source: 'memory_pass', now: NOW });
ok('10 "no longer true" from a coach only flags it for Jeet', plan.updates[0].patch.pending === 'retract' && !plan.updates[0].patch.status && plan.events[0].action === 'retract_proposed');
plan = M.planPropose(live, [{ text: 'Overcoming fear of failing step by step', replaces: 'Fear of failing' }], { coach: 'mind', source: 'tag', now: NOW });
ok('11 an update to a private fact stays private', plan.inserts[0].scope === 'private:mind');
plan = M.planPropose([], Array.from({ length: 20 }, (_, i) => ({ text: 'Fact number ' + i })), { coach: 'fitness', source: 'tag', now: NOW });
ok('12 at most 8 proposals per call', plan.inserts.length === 8);

const mem = { id: 'x', kind: 'preference', text: 'Likes paneer', norm: 'likes paneer', scope: 'private:mind', status: 'unconfirmed', pending: 'retract' };
plan = M.planAct(mem, 'confirm', { now: NOW });
ok('13 confirm → active, high, jeet_confirmed, review reset', plan.updates[0].patch.status === 'active' && plan.updates[0].patch.confidence === 'high' && plan.updates[0].patch.review_after === '2027-02-17' && plan.updates[0].patch.pending === null);
plan = M.planAct(mem, 'edit', { text: 'Likes paneer tikka, not curry', now: NOW });
ok('14 edit = new high-confidence fact superseding the old', plan.inserts[0].source_type === 'jeet_confirmed' && plan.inserts[0].supersedes === 'x' && plan.inserts[0].scope === 'private:mind' && plan.updates[0].patch.status === 'superseded');
ok('15 edit with the same text → no change', M.planAct(mem, 'edit', { text: 'likes  PANEER' }).error === 'no change');
ok('16 share private → team', M.planAct(mem, 'share').updates[0].patch.scope === 'team');
ok('17 keep (reject a proposed retraction) clears the flag', M.planAct(mem, 'keep').updates[0].patch.pending === null);
ok('18 retract is a status, never a delete', M.planAct(mem, 'retract').updates[0].patch.status === 'retracted');
ok('19 superseded/retracted memories can\'t be acted on', M.planAct(Object.assign({}, mem, { status: 'superseded' }), 'confirm').error === 'memory is not live');
ok('20 unknown op rejected', M.planAct(mem, 'delete').error === 'unknown op');

// ── Visibility + labels ──
const rows = [
  { id: '1', kind: 'constraint', text: 'Exams till 30 Oct', scope: 'team', source_type: 'jeet_said', status: 'active', observed_at: '2026-10-14T00:00:00Z', review_after: '2026-12-13' },
  { id: '2', kind: 'struggle', text: 'Panics before exams', scope: 'private:mind', source_type: 'jeet_said', status: 'active', observed_at: '2026-10-14T00:00:00Z', review_after: '2026-12-13' },
  { id: '3', kind: 'preference', text: 'Probably dislikes oats', scope: 'team', source_type: 'coach_inferred', status: 'unconfirmed', observed_at: '2026-10-10T00:00:00Z', review_after: '2027-02-07' },
  { id: '4', kind: 'fact', text: 'Weighs 92 kg', scope: 'team', source_type: 'migrated', status: 'active', observed_at: '2026-01-01T00:00:00Z', review_after: '2026-06-30' },
  { id: '5', kind: 'fact', text: 'Old superseded thing', scope: 'team', source_type: 'jeet_said', status: 'superseded', observed_at: '2026-01-01T00:00:00Z' },
];
const pk = (coach) => buildPacket({ memories: rows }, { coach, now: Date.parse('2026-10-20T10:00:00+05:30') }).text;
const fit = pk('fitness'), mind = pk('mind');
ok('21 coaches see team facts with date + source', /Exams till 30 Oct \(6 days ago; Jeet said\)/.test(fit), (fit.match(/\[routine\][^\n]*/) || [''])[0]);
ok('22 private mind facts only reach the mind coach', !/Panics before exams/.test(fit) && /Panics before exams .*PRIVATE to you/.test(mind));
ok('23 guesses are marked unconfirmed', /Probably dislikes oats .*UNCONFIRMED guess/.test(fit));
ok('24 stale facts are marked "may be outdated"', /Weighs 92 kg .*may be outdated/.test(fit));
ok('25 superseded facts never reach coaches', !/Old superseded thing/.test(fit));

// ── Endpoint against an in-memory table ──
const osPath = require('path').join(__dirname, '../api/os.js');
function server(owner = true) {
  const db = { mem: [], ev: [] };
  global.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url));
    const j = (b, st = 200) => ({ ok: st < 300, status: st, json: async () => b });
    if (u.includes('rpc/jeetos_is_owner')) return j(owner);
    const filt = (list) => {
      let out = list;
      const id = /id=eq\.([a-z0-9]+)/i.exec(u); if (id) out = out.filter(m => m.id === id[1]);
      const st = /status=in\.\(([^)]+)\)/.exec(u); if (st) out = out.filter(m => st[1].split(',').includes(m.status));
      return out;
    };
    if (u.includes('/jeetos_memory_events')) {
      if (init.method === 'POST') { db.ev.push(...JSON.parse(init.body)); return j(null, 201); }
      const id = /memory_id=eq\.([a-z0-9]+)/i.exec(u)[1]; return j(db.ev.filter(e => e.memory_id === id));
    }
    if (u.includes('/jeetos_memories')) {
      if (init.method === 'POST') {
        const row = JSON.parse(init.body);
        if (db.mem.some(m => ['active', 'unconfirmed'].includes(m.status) && m.norm === row.norm)) return j({ message: 'duplicate' }, 409);
        db.mem.push(Object.assign({ pending: null }, row)); return j([row], 201);
      }
      if (init.method === 'PATCH') { const hit = filt(db.mem); hit.forEach(m => Object.assign(m, JSON.parse(init.body))); return j(hit); }
      return j(filt(db.mem));
    }
    return j([]);
  };
  delete require.cache[osPath]; delete require.cache[require.resolve('../api/_auth.js')];
  const h = require(osPath);
  const call = (req) => new Promise(res => h(Object.assign({ headers: { authorization: 'Bearer h.p.s' }, query: {} }, req), { status: c => ({ json: b => res({ code: c, body: b }) }) }));
  return { db, call };
}
(async () => {
  let s = server(false);
  let x = await s.call({ method: 'GET', query: { action: 'memories' } });
  ok('26 endpoint is owner-only', x.code === 401);
  s = server();
  x = await s.call({ method: 'POST', body: { action: 'memory.propose', coach: 'fitness', source: 'tag', items: [{ text: 'Gym after 6 pm', section: 'routine' }, { text: 'Gym after 6 pm' }, { text: 'Maybe hates cardio' }] } });
  ok('27 propose: 2 created (dup dropped), guess unconfirmed', x.code === 200 && s.db.mem.length === 2 && s.db.mem.find(m => /cardio/.test(m.text)).status === 'unconfirmed', s.db.mem.map(m => [m.text, m.status]));
  const gym = s.db.mem.find(m => /Gym/.test(m.text));
  x = await s.call({ method: 'POST', body: { action: 'memory.propose', coach: 'fitness', source: 'memory_pass', items: [{ text: 'Gym at 9:30 am', replaces: 'Gym after 6 pm', section: 'routine' }] } });
  const newer = s.db.mem.find(m => /9:30/.test(m.text));
  ok('28 supersede persisted both ways', gym.status === 'superseded' && gym.superseded_by === newer.id && newer.supersedes === gym.id);
  x = await s.call({ method: 'POST', body: { action: 'memory.act', id: newer.id, op: 'edit', text: 'Gym at 9:30 am, Mon-Sat' } });
  const edited = s.db.mem.find(m => /Mon-Sat/.test(m.text));
  ok('29 edit via endpoint → new confirmed fact, old superseded', x.code === 200 && edited.source_type === 'jeet_confirmed' && newer.status === 'superseded');
  x = await s.call({ method: 'GET', query: { action: 'memories', id: gym.id } });
  ok('30 history shows create → supersede', x.body.events.map(e => e.action).join() === 'create,supersede', x.body.events.map(e => e.action));
  x = await s.call({ method: 'POST', body: { action: 'memory.act', id: edited.id, op: 'edit', text: 'Maybe hates cardio' } });
  ok('31 editing into an existing fact → 409, old one untouched', x.code === 409 && edited.status === 'active');
  x = await s.call({ method: 'POST', body: { action: 'memory.act', id: 'nope', op: 'confirm' } });
  ok('32 unknown id → 404', x.code === 404);
  x = await s.call({ method: 'GET', query: { action: 'memories' } });
  ok('33 list returns live + closed', x.body.live.length === 2 && x.body.closed.length === 2, [x.body.live.length, x.body.closed.length]);
  ok('34 every change audited', s.db.ev.length >= 6 && s.db.ev.every(e => e.actor && e.action));
})();
