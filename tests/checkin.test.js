// Daily check-in: adaptive questions, validation, log overlay, endpoint, packet.
const C = require('../api/_checkin.js');
const { buildPacket, loadContextData } = require('../api/_context.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 260) : ''));
const ids = qs => qs.map(q => q.id).join(',');

let q = C.questionsFor('morning', {});
ok('1 morning, nothing logged → 5 questions max', q.length === 5 && ids(q) === 'sleep_hours,bedtime,energy,mood,free_hours', ids(q));
q = C.questionsFor('morning', { log: { sleep_hours: 7, mood: 4 }, todayPriority: { text: 'Gym' } });
ok('2 already-logged sleep/mood and a set priority are skipped', ids(q) === 'energy,free_hours', ids(q));
q = C.questionsFor('evening', { plan: { top3: [{ title: 'Gym at 10 PM' }, { title: 'Send leg video' }] }, log: { mood: 3 } });
ok('3 evening: done-list from today\'s plan, why, one change', ids(q) === 'done,blocker,blocker_note,tomorrow' && q[0].options.length === 2, ids(q));

let c = C.cleanAnswers('morning', C.questionsFor('morning', {}, true), { sleep_hours: 6.7, bedtime: '00:40', energy: 4, mood: 3, free_hours: '1-2h' }, ['sleep_hours', 'bedtime', 'energy', 'mood', 'free_hours']);
ok('4 valid morning answers accepted (hours rounded to .5)', !c.error && c.answers.sleep_hours === 6.5, c);
ok('5 out-of-range / wrong types rejected', C.cleanAnswers('morning', C.questionsFor('morning', {}, true), { energy: 9 }).error === 'bad energy' && C.cleanAnswers('morning', C.questionsFor('morning', {}, true), { bedtime: '25:00' }).error === 'bad bedtime');
ok('6 unexpected keys rejected', /unexpected/.test(C.cleanAnswers('morning', C.questionsFor('morning', {}, true), { password: 'x' }).error));
ok('7 required answers enforced', C.cleanAnswers('morning', C.questionsFor('morning', {}, true), { energy: 3 }, ['energy', 'free_hours']).error === 'missing free_hours');
const eq = C.questionsFor('evening', { plan: { top3: [{ title: 'Gym' }, { title: 'Video' }] } });
c = C.cleanAnswers('evening', eq, { done: ['Gym'], blocker: 'time', blocker_note: '<b>library</b> late', tomorrow: 'Video before lunch', mood: 3 });
ok('8 evening: not_done derived, tags stripped', !c.error && JSON.stringify(c.answers.not_done) === '["Video"]' && c.answers.blocker_note === 'library late', c);
ok('9 done-list only accepts plan items', C.cleanAnswers('evening', eq, { done: ['Hacked'] }).error === 'bad done');

const l = C.overlayLog({ day: '2026-10-20', sleep_hours: null, mood: 5 }, { day: '2026-10-20', answers: { sleep_hours: 7, mood: 2, energy: 3 } });
ok('10 overlay fills gaps, never overwrites his log', l.sleep_hours === 7 && l.sleep_from === 'checkin' && l.mood === 5 && l.energy === 3);
ok('11 due windows: morning 5-14, evening 20-03', C.due('morning', 8) && !C.due('morning', 15) && C.due('evening', 22) && C.due('evening', 1) && !C.due('evening', 12));

// Through the loader: a morning check-in feeds the plan (low energy → minimum workout) and the packet
(async () => {
  const NOW = Date.parse('2026-10-20T11:15:00+05:30');
  const rows = {
    'jeetos_daily_checkins': [{ day: '2026-10-20', kind: 'morning', answers: { sleep_hours: 5, energy: 1, mood: 2, free_hours: '<1h', priority: 'Finish assignment' } },
      { day: '2026-10-19', kind: 'evening', answers: { done: ['Gym'], not_done: ['Leg video'], blocker: 'time', tomorrow: 'Video before lunch' } }],
    'jeetos_anchor_checkins': [{ anchor: 'wake', day: '2026-10-20' }],
  };
  const raw = await loadContextData(async p => { for (const k of Object.keys(rows)) if (p.startsWith(k)) return rows[k]; return []; }, NOW);
  const pk = buildPacket(raw, { coach: 'fitness', now: NOW });
  ok('12 check-in sleep fills the empty log (goal health + packet see it)', raw.logs.some(x => x.day === '2026-10-20' && x.sleep_hours === 5));
  ok('13 low morning energy → planner offers the minimum workout', pk.plan.changes.some(x => x.type === 'minimum'), pk.plan.changes);
  ok('14 morning priority becomes today\'s priority', pk.plan.top3.some(t => t.title === 'Finish assignment') || /Finish assignment/.test(pk.text));
  ok('15 packet shows both check-ins in his words', /energy 1\/5/.test(pk.text) && /not done Leg video; why: time/.test(pk.text) && /he'll change: "Video before lunch"/.test(pk.text));
  const pk2 = buildPacket(Object.assign({}, raw, { dailyCheckins: [] }), { coach: 'fitness', now: NOW });
  ok('16 no morning check-in → listed as unknown', pk2.unknowns.includes('no morning check-in yet'));

  // Endpoint
  const osPath = require('path').join(__dirname, '../api/os.js');
  const saved = [];
  global.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url)); const j = (b, st = 200) => ({ ok: st < 300, status: st, json: async () => b });
    if (u.includes('rpc/jeetos_is_owner')) return j(true);
    if (u.includes('jeetos_daily_checkins?on_conflict')) { saved.push(JSON.parse(init.body)); return j([saved.slice(-1)[0]], 201); }
    return j([]);
  };
  delete require.cache[osPath]; delete require.cache[require.resolve('../api/_auth.js')];
  const h = require(osPath);
  const call = req => new Promise(res => h(Object.assign({ headers: { authorization: 'Bearer h.p.s' }, query: {} }, req), { status: c2 => ({ json: b => res({ code: c2, body: b }) }) }));
  const RealNow = Date.now; Date.now = () => Date.parse('2026-10-20T08:30:00+05:30');
  let x = await call({ method: 'GET', query: { action: 'checkin' } });
  ok('17 8:30 AM → morning check-in due with its questions', x.body.kind === 'morning' && x.body.questions.length === 5, x.body);
  x = await call({ method: 'POST', body: { action: 'checkin.save', kind: 'morning', answers: { sleep_hours: 7, bedtime: '00:20', energy: 4, mood: 4, free_hours: '2-4h' } } });
  ok('18 save → upsert keyed day:kind', x.code === 200 && saved[0].id === '2026-10-20:morning' && saved[0].answers.energy === 4);
  x = await call({ method: 'POST', body: { action: 'checkin.save', kind: 'morning', answers: { energy: 4 } } });
  ok('19 missing required answers refused', x.code === 400 && /missing/.test(x.body.error));
  x = await call({ method: 'POST', body: { action: 'checkin.save', kind: 'night', answers: {} } });
  ok('20 bad kind refused', x.code === 400);
  Date.now = () => Date.parse('2026-10-20T15:00:00+05:30');
  x = await call({ method: 'GET', query: { action: 'checkin' } });
  ok('21 3 PM → nothing due', x.body.kind === null);
  Date.now = RealNow;
})();
