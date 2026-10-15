// api/ai.js + the shared context engine: owner-only, appended to the live
// part of the prompt, and the chat still works if the context can't be built.
const path = require('path').join(__dirname, '../api/ai.js');
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 260) : ''));
const JWT = 'h.p.s';

function call(req, { owner = true, dbDown = false } = {}) {
  let sent = null; const asked = [], auths = [];
  global.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url)); asked.push(u); if (u.includes('/rest/v1/jeetos_')) auths.push((init.headers || {}).Authorization);
    const j = (b, st = 200) => ({ ok: st < 300, status: st, json: async () => b, text: async () => JSON.stringify(b) });
    if (u.includes('rpc/jeetos_is_owner')) return j(owner);
    if (u.includes('api.anthropic.com')) { sent = JSON.parse(init.body); return j({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'theek hai' }] }); }
    if (dbDown) throw new Error('network');
    if (u.includes('jeetos_team_memory')) return j([{ fact: 'Exams till 30 Oct', from_coach: 'mind', created_on: '2026-10-14' }]);
    if (u.includes('jeetos_penalty_incidents')) return j([{ id: 'i', title: 'Lunch late', status: 'assessed', updated_at: '2026-10-14T00:00:00Z' }]);
    return j([]);
  };
  delete require.cache[path]; delete require.cache[require.resolve('../api/_auth.js')];
  const h = require(path);
  return new Promise(res => {
    const out = { status: c => ({ json: b => res({ code: c, body: b, sent, asked, auths }) }) };
    h(Object.assign({ headers: { authorization: 'Bearer ' + JWT } }, req), out);
  });
}
const sysText = s => Array.isArray(s) ? s.map(b => b.text).join('\n') : String(s);

(async () => {
  let r = await call({ method: 'GET', query: { context: 'fitness' } }, { owner: false });
  ok('1 GET ?context needs the owner', r.code === 401);
  r = await call({ method: 'GET', query: { context: 'fitness' } });
  ok('2 owner sees the packet as JSON (text + next action)', r.code === 200 && /TEAM CONTEXT for Marcus/.test(r.body.text) && typeof r.body.nextAction === 'string');
  r = await call({ method: 'GET', query: { context: 'nobody' } });
  ok('3 unknown coach → 400', r.code === 400);

  const body = { system: 'STABLE PERSONA\n\n<<<LIVE>>>\n\nlive app data', messages: [{ role: 'user', content: 'hi' }], context: { coach: 'nutrition', purpose: 'chat' } };
  r = await call({ method: 'POST', body });
  const blocks = r.sent && r.sent.system;
  ok('4 packet goes into the live (uncached) block, persona stays cached', Array.isArray(blocks) && blocks[0].cache_control && !/TEAM CONTEXT/.test(blocks[0].text) && /TEAM CONTEXT for Maya/.test(blocks[1].text), Array.isArray(blocks) ? blocks.map(b => b.text.slice(0, 40)) : blocks);
  ok('5 newest team memory reaches the chat', /Exams till 30 Oct/.test(sysText(blocks)));
  ok('6 nutrition coach never sees the ledger', !/Lunch late/.test(sysText(blocks)));
  ok('7 response says context ok', r.body.context === 'ok' && r.body.text === 'theek hai');

  r = await call({ method: 'POST', body: Object.assign({}, body, { context: { coach: 'ronaldo' } }) });
  ok('8 accountability coach does see the ledger', /Lunch late: assessed/.test(sysText(r.sent.system)));

  r = await call({ method: 'POST', body }, { dbDown: true });
  ok('9 DB unreachable → chat still answers, packet says the data is unknown (not empty)', r.code === 200 && r.body.text === 'theek hai' && /couldn't read part of his data/.test(sysText(r.sent.system)));

  r = await call({ method: 'POST', body: { system: 'x', messages: [{ role: 'user', content: 'hi' }] } });
  ok('10 calls without context are unchanged (no packet, no DB reads)', !/TEAM CONTEXT/.test(sysText(r.sent.system)) && !r.asked.some(u => u.includes('/rest/v1/jeetos_')) && r.body.context === undefined);

  r = await call({ method: 'POST', body: Object.assign({}, body, { context: { coach: '../../etc' } }) });
  ok('11 bad coach id ignored safely', r.code === 200 && !/TEAM CONTEXT/.test(sysText(r.sent.system)));
  r = await call({ method: 'POST', body });
  ok('13 without a server key, context reads use the owner\'s login token (owner-only tables readable)', r.auths.length > 10 && r.auths.every(a => a === 'Bearer ' + JWT), [...new Set(r.auths)]);
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key';
  r = await call({ method: 'POST', body });
  ok('14 with a server key, that is used first', r.auths.every(a => a === 'Bearer svc-key'));
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  r = await call({ method: 'POST', body }, { owner: false });
  ok('12 POST still owner-only', r.code === 401 && !r.sent);
})();
