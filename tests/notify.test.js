// Notification budget: rules (api/_notify.js), enforcement inside sendToAll
// (api/_push.js), and the settings endpoint (api/os.js).
const N = require('../api/_notify.js');
const ok = (n, c, e) => console.log((c ? 'PASS ' : 'FAIL ') + n + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 260) : ''));
const T = s => Date.parse(s);
const at = (hm, d = '2026-10-20') => T(`${d}T${hm}:00+05:30`);
const sent = (n, cls = 'nudge', lastAt = '2026-10-20T03:00:00Z') => Array.from({ length: n }, () => ({ cls, at: lastAt }));

ok('1 classes from tags', N.classOf('sleep-a_wake') === 'alarm' && N.classOf('settle-2026-10-20') === 'deadline' && N.classOf('fitness-evening') === 'nudge' && N.classOf('test') === 'test');
ok('2 nudge in quiet hours (2 AM) held', !N.decide({ tag: 'mind-night', now: at('02:00'), sentToday: [] }).ok);
ok('3 quiet window wraps midnight: 00:50 held, 07:50 allowed', !N.decide({ tag: 'x-morning', now: at('00:50'), sentToday: [] }).ok && N.decide({ tag: 'x-morning', now: at('07:50'), sentToday: [] }).ok);
ok('4 his own alarms ring even in quiet hours', N.decide({ tag: 'sleep-a_sleep', now: at('00:50'), sentToday: [] }).ok);
ok('5 nudges stop at the daily cap (8)', !N.decide({ tag: 'style-afternoon', now: at('18:00'), sentToday: sent(8) }).ok && /cap 8/.test(N.decide({ tag: 'style-afternoon', now: at('18:00'), sentToday: sent(8) }).reason));
ok('6 alarms still ring after the cap, until the hard ceiling', N.decide({ tag: 'nutrition-a_dinner', now: at('23:10'), sentToday: sent(10) }).ok && !N.decide({ tag: 'nutrition-a_dinner', now: at('23:10'), sentToday: sent(14) }).ok);
ok('7 deadlines get 2 extra past the cap', N.decide({ tag: 'settle-2026-10-20', now: at('18:00'), sentToday: sent(9) }).ok && !N.decide({ tag: 'settle-2026-10-20', now: at('18:00'), sentToday: sent(10) }).ok);
ok('8 no two nudges within an hour', !N.decide({ tag: 'ronaldo-evening', now: at('17:00'), sentToday: [{ cls: 'nudge', at: '2026-10-20T11:10:00Z' }] }).ok && N.decide({ tag: 'ronaldo-evening', now: at('17:00'), sentToday: [{ cls: 'nudge', at: '2026-10-20T10:00:00Z' }] }).ok);
ok('9 an alarm right after a nudge is fine', N.decide({ tag: 'fitness-a_gym', now: at('09:40'), sentToday: [{ cls: 'nudge', at: '2026-10-20T04:05:00Z' }] }).ok);
ok('10 unreadable log → fail open on the cap, quiet hours still hold', N.decide({ tag: 'x-evening', now: at('18:00'), sentToday: null }).ok && !N.decide({ tag: 'x-night', now: at('03:00'), sentToday: null }).ok);
ok('11 his settings apply (cap 4, quiet 23:00–08:00)', !N.decide({ tag: 'x-evening', now: at('18:00'), sentToday: sent(4), settings: { daily_cap: 4 } }).ok && !N.decide({ tag: 'x-night', now: at('23:30'), sentToday: [], settings: { quiet_from: '23:00', quiet_to: '08:00' } }).ok);
ok('12 bad settings ignored (defaults kept)', JSON.stringify(N.settingsOf({ daily_cap: 999, quiet_from: '25:00', quiet_to: 'x' })) === JSON.stringify(N.DEFAULTS));
ok('13 test button always goes through', N.decide({ tag: 'test', now: at('03:00'), sentToday: sent(20) }).ok);

// sendToAll with a fake DB + push service
const push = require('../api/_push.js');
process.env.VAPID_SEED = 'test-seed';
function fakeDb(state) {
  return async (path, init = {}) => {
    const j = (b, st = 200) => ({ ok: st < 300, status: st, json: async () => b });
    if (path.startsWith('jeetos_push_log?')) return state.unreadable ? j({ message: 'denied' }, 401) : j(state.log.filter(r => r.decision === 'sent'));
    if (path === 'jeetos_push_log') { state.log.push(JSON.parse(init.body)); return j(null, 201); }
    if (path.startsWith('jeetos_settings')) return j(state.settings ? [{ data: state.settings }] : []);
    if (path.startsWith('jeetos_push_subs?select')) return j(state.subs || []);
    return j([]);
  };
}
(async () => {
  const sub = { endpoint: 'https://push.example/abc', p256dh: push.b64u(require('crypto').createECDH('prime256v1').generateKeys()), auth: push.b64u(require('crypto').randomBytes(16)) };
  let delivered = 0;
  global.fetch = async () => { delivered++; return { status: 201 }; };
  const RealNow = Date.now;
  Date.now = () => at('03:00');
  let st = { log: [], subs: [sub] };
  let r = await push.sendToAll(fakeDb(st), { title: 'x', body: 'y', tag: 'mind-night' });
  ok('14 quiet hours: held, nothing delivered, logged as held', r.sent === 0 && /quiet/.test(r.held) && delivered === 0 && st.log[0].decision === 'held');
  Date.now = () => at('18:00');
  st = { log: Array.from({ length: 8 }, () => ({ decision: 'sent', cls: 'nudge', at: '2026-10-20T03:00:00Z' })), subs: [sub] };
  r = await push.sendToAll(fakeDb(st), { title: 'x', body: 'y', tag: 'style-evening' });
  ok('15 over the cap: nudge held', r.sent === 0 && /cap/.test(r.held) && delivered === 0);
  r = await push.sendToAll(fakeDb(st), { title: 'x', body: 'y', tag: 'nutrition-a_dinner' });
  ok('16 over the cap: his alarm still delivered and logged as sent', r.sent === 1 && delivered === 1 && st.log.slice(-1)[0].decision === 'sent' && st.log.slice(-1)[0].cls === 'alarm');
  st = { log: [], subs: [sub], unreadable: true };
  r = await push.sendToAll(fakeDb(st), { title: 'x', body: 'y', tag: 'fitness-evening' });
  ok('17 log unreadable → still sends (fail open)', r.sent === 1);
  Date.now = RealNow;

  // Settings endpoint
  const osPath = require('path').join(__dirname, '../api/os.js');
  const store = {};
  global.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url)); const j = (b, s2 = 200) => ({ ok: s2 < 300, status: s2, json: async () => b });
    if (u.includes('rpc/jeetos_is_owner')) return j(true);
    if (u.includes('jeetos_settings') && init.method === 'POST') { const b = JSON.parse(init.body); store[b.id] = b; return j([b], 201); }
    if (u.includes('jeetos_settings')) return j(store.notify ? [store.notify] : []);
    return j([]);
  };
  delete require.cache[osPath]; delete require.cache[require.resolve('../api/_auth.js')];
  const h = require(osPath);
  const call = req => new Promise(res => h(Object.assign({ headers: { authorization: 'Bearer h.p.s' }, query: {} }, req), { status: c => ({ json: b => res({ code: c, body: b }) }) }));
  let x = await call({ method: 'GET', query: { action: 'notify' } });
  ok('18 settings default to cap 8, quiet 00:45–07:45', x.body.settings.daily_cap === 8 && x.body.settings.quiet_from === '00:45');
  x = await call({ method: 'POST', body: { action: 'notify.set', settings: { daily_cap: 5, quiet_from: '23:30', quiet_to: '08:00' } } });
  ok('19 save valid settings', x.code === 200 && store.notify.data.daily_cap === 5 && store.notify.data.quiet_from === '23:30');
  x = await call({ method: 'POST', body: { action: 'notify.set', settings: { daily_cap: 50 } } });
  ok('20 out-of-range value rejected (not silently ignored)', x.code === 400 && /daily_cap/.test(x.body.error));
  x = await call({ method: 'POST', body: { action: 'notify.set', settings: { evil: 1 } } });
  ok('21 unknown setting rejected', x.code === 400);
})();
