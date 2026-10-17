// Knowledge vault (api/_vault.js + /api/os docs + coach chat): full-text search,
// citations, private docs never reach a coach, no guessing when nothing matches.
const V = require('../api/_vault.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''));

let c = V.cleanDoc({ title: '  Derma <b>plan</b> ', body: 'Tretinoin 0.025 at night <script>x</script>', tags: '#skin, Night routine', scope: 'private' });
ok('1 clean: html stripped, tags normalised, scope kept', c.row.title === 'Derma plan' && c.row.body === 'Tretinoin 0.025 at night x' && c.row.tags.join(',') === 'skin,night,routine' && c.row.scope === 'private' && c.row.source === 'note', c.row);
ok('2 title required', !!V.cleanDoc({ body: 'x' }).error);
ok('3 max 20,000 characters', /20,000/.test(V.cleanDoc({ title: 'x', body: 'a'.repeat(20001) }).error));
ok('4 bad link refused; good link → source "link"', !!V.cleanDoc({ title: 'x', url: 'javascript:alert(1)' }).error && V.cleanDoc({ title: 'x', url: 'https://aad.org/acne' }).row.source === 'link');
ok('5 long paste → source "pasted"', V.cleanDoc({ title: 'x', body: 'a '.repeat(1000) }).row.source === 'pasted');
ok('6 edit keeps unchanged fields', (() => { const r = V.cleanDoc({ title: 'New' }, { title: 'Old', body: 'B', tags: ['t'], scope: 'private' }).row; return r.title === 'New' && r.body === 'B' && r.tags[0] === 't' && r.scope === 'private'; })());
ok('7 query from a Hinglish message: stopwords out, OR-joined', V.queryFrom('Bhai mera tretinoin wala plan kya tha raat ko?') === 'tretinoin or plan or raat', V.queryFrom('Bhai mera tretinoin wala plan kya tha raat ko?'));
ok('7b drug name kept', /tretinoin/.test(V.queryFrom('tretinoin kab lagana hai')));
ok('8 nothing searchable → null', V.queryFrom('ok bhai haan') === null && V.queryFrom('') === null);
const hits = [{ title: 'Derma plan', snippet: '«Tretinoin» 0.025 at night', updated_at: '2026-10-10T05:00:00Z', scope: 'team' }, { title: 'Therapy', snippet: 'x', updated_at: '2026-10-11T00:00:00Z', scope: 'private' }];
const lines = V.vaultLines(hits);
ok('9 lines cite [title, date]; private filtered even if returned', lines.length === 1 && lines[0] === '[Derma plan, 2026-10-10] «Tretinoin» 0.025 at night', lines);

(async () => {
  let seen;
  let r = await V.searchVault(async (n, b) => { seen = { n, b }; return hits; }, 'tretinoin', {});
  ok('10 coach search asks for team docs only', seen.n === 'jeetos_search_docs' && seen.b.include_private === false && r.length === 2);
  r = await V.searchVault(async () => { throw new Error('down'); }, 'x', {});
  ok('11 search failure → null (never throws)', r === null);
  ok('12 no query → no call', (await V.searchVault(async () => { throw new Error('called'); }, null)).length === 0);

  // Endpoint
  const osPath = require('path').join(__dirname, '../api/os.js');
  const docs = [], rpcCalls = [];
  global.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url)); const j = (b, st = 200) => ({ ok: st < 300, status: st, json: async () => b });
    if (u.includes('rpc/jeetos_is_owner')) return j(true);
    if (u.includes('rpc/jeetos_search_docs')) { const b = JSON.parse(init.body); rpcCalls.push(b); return j(docs.filter(d => (b.include_private || d.scope === 'team') && (d.title + ' ' + d.body).toLowerCase().includes(b.q.split(' or ')[0])).map(d => Object.assign({ snippet: d.body.slice(0, 40) }, d))); }
    if (u.includes('/jeetos_docs') && init.method === 'POST') { const d = JSON.parse(init.body); docs.push(d); return j([d], 201); }
    if (u.includes('/jeetos_docs') && init.method === 'PATCH') { const id = /id=eq\.([^&]+)/.exec(u)[1]; Object.assign(docs.find(d => d.id === id), JSON.parse(init.body)); return j([{}]); }
    if (u.includes('/jeetos_docs?id=eq.')) { const id = /id=eq\.([^&]+)/.exec(u)[1]; return j(docs.filter(d => d.id === id)); }
    if (u.includes('/jeetos_docs')) return j(docs.filter(d => d.status === 'active'));
    return j([]);
  };
  delete require.cache[osPath]; delete require.cache[require.resolve('../api/_auth.js')];
  const os = require(osPath), call = req => new Promise(res => os(Object.assign({ headers: { authorization: 'Bearer h.p.s' }, query: {} }, req), { status: c => ({ json: b => res({ code: c, body: b }) }) }));
  let x = await call({ method: 'POST', body: { action: 'docs.add', title: 'Derma plan', body: 'tretinoin 0.025 at night', tags: 'skin' } });
  ok('13 add → stored active', x.code === 200 && docs[0].status === 'active' && docs[0].tags[0] === 'skin');
  await call({ method: 'POST', body: { action: 'docs.add', title: 'Therapy notes', body: 'tretinoin anxiety', scope: 'private' } });
  x = await call({ method: 'GET', query: { action: 'docs', q: 'tretinoin' } });
  ok('14 his own search includes private docs', x.code === 200 && x.body.hits.length === 2 && rpcCalls.pop().include_private === true);
  x = await call({ method: 'POST', body: { action: 'docs.add', title: '', body: 'x' } });
  ok('15 invalid doc refused', x.code === 400);
  x = await call({ method: 'POST', body: { action: 'docs.update', id: docs[0].id, body: 'tretinoin 0.05 now' } });
  ok('16 update keeps title, changes body', x.code === 200 && docs[0].title === 'Derma plan' && docs[0].body === 'tretinoin 0.05 now');
  x = await call({ method: 'POST', body: { action: 'docs.archive', id: docs[1].id } });
  ok('17 archive (no delete)', x.code === 200 && docs[1].status === 'archived');
  x = await call({ method: 'POST', body: { action: 'docs.archive', id: 'nope' } });
  ok('18 unknown id → 404', x.code === 404);

  // Coach chat: vault matches go into the system prompt with citations; private never.
  docs[1].status = 'active';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  const aiPath = require('path').join(__dirname, '../api/ai.js');
  let sys = null;
  const base = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('api.anthropic.com')) { sys = JSON.parse(init.body).system; const t = Array.isArray(sys) ? sys.map(s => s.text).join('\n') : sys; sys = t; return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }) }; }
    return base(url, init);
  };
  delete require.cache[aiPath];
  const ai = require(aiPath);
  const chat = body => new Promise(res => ai({ method: 'POST', headers: { authorization: 'Bearer h.p.s' }, query: {}, body }, { status: c => ({ json: b => res({ code: c, body: b }) }), setHeader() { } }));
  x = await chat({ system: 'You are the skin coach.', messages: [{ role: 'user', content: 'mera tretinoin kitna strong hai?' }], context: { coach: 'skin', purpose: 'chat' }, provider: 'claude' });
  const call0 = rpcCalls.pop();
  ok('19 chat: coach search is team-only', call0 && call0.include_private === false, call0);
  ok('20 chat: vault section with [title, date] citation in the prompt', /FROM HIS KNOWLEDGE VAULT/.test(sys || '') && /\[Derma plan, \d{4}-\d{2}-\d{2}\]/.test(sys || '') && !/Therapy notes/.test(sys || ''), (sys || '').slice(-400));
  sys = null;
  x = await chat({ system: 'You are the skin coach.', messages: [{ role: 'user', content: 'ok bhai' }], context: { coach: 'skin', purpose: 'chat' }, provider: 'claude' });
  ok('21 nothing to search → no vault section', sys != null && !/KNOWLEDGE VAULT/.test(sys), (sys || '').slice(-120));
})();
