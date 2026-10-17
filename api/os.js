// api/os.js — JeetOS "operating system" actions (one function, action-routed,
// to stay under the Vercel Hobby function limit). Owner only.
//
//   GET  /api/os?action=memories            live memories + recently closed ones
//   GET  /api/os?action=memories&id=<id>    one memory's history
//   POST /api/os { action: "memory.propose", coach, source, items: [...] }
//   POST /api/os { action: "memory.act", id, op: confirm|retract|keep|edit|share, text? }
//   GET  /api/os?action=today               Command Centre: plan, next action, goals, promises
//   GET  /api/os?action=notify              notification budget settings + today's push log
//   POST /api/os { action: "notify.set", settings: { daily_cap, quiet_from, quiet_to, nudge_gap_min } }
//   GET  /api/os?action=checkin             which check-in is due now + its questions
//   POST /api/os { action: "checkin.save", kind: morning|evening, answers }
//   GET  /api/os?action=habits              7/30-day consistency + why things get missed
//   GET  /api/os?action=insights            patterns in his data (with sample sizes)
//   GET  /api/os?action=journal             decision journal (+ which are due for review)
//   POST /api/os { action: "journal.add", change, area?, alternatives?, expected?, review_on? }
//   POST /api/os { action: "journal.outcome", id, verdict: worked|didnt|unclear, actual? }
//   GET  /api/os?action=repair              schedule-change proposals for anchors that keep slipping
//   POST /api/os { action: "repair.approve" | "repair.reject", id }  /  { action: "repair.revert", anchor }
//   GET  /api/os?action=huddle              today's Head Coach huddle (null if not run yet)
//   POST /api/os { action: "huddle.run" }   run it now if today's doesn't exist (idempotent)
//   GET  /api/os?action=review              latest Weekly CEO Review (+ whether last week's is missing)
//   POST /api/os { action: "review.run" }   build last week's review if it doesn't exist (idempotent)
//   GET  /api/os?action=goals               goal graph + live health (+ the proposal if none yet)
//   POST /api/os { action: "goals.approve" }                 create the proposed graph
//   POST /api/os { action: "goals.target", id, target: {..} } tune a goal's numbers
//   POST /api/os { action: "goals.cancel" | "goals.resume", id }
//
// Rules live in api/_memory.js; this file only reads, applies and audits.
const { requireOwner, bearer, SUPABASE_URL, PUBLIC_KEY } = require("./_auth");
const { planPropose, planAct } = require("./_memory");
const { PLAN, graphHealth, approvalRows, cleanTarget } = require("./_goals");
const { settingsOf, DEFAULTS: NOTIFY_DEFAULTS, LIMITS: NOTIFY_LIMITS } = require("./_notify");
const { loadContextData, planDay, buildPacket, todayPlan, reviewDay } = require("./_context");
const { questionsFor, cleanAnswers, due: checkinDue } = require("./_checkin");
const { habitReport } = require("./_habits");
const { insightReport } = require("./_insights");
const repair = require("./_repair");
const { ensureHuddle } = require("./_huddle");
const { ensureReview, reviewWeek } = require("./_review");
const { callClaude } = require("./_claude");

// The server key when configured; otherwise act as the logged-in owner (RLS allows the owner).
function makeDb(req) {
  const svc = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "").trim();
  const token = bearer(req);
  const headers = svc ? { apikey: svc, Authorization: "Bearer " + svc } : { apikey: PUBLIC_KEY, Authorization: "Bearer " + token };
  return async function db(path, init) {
    init = init || {};
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, Object.assign({}, init, {
      headers: Object.assign({ "Content-Type": "application/json", Prefer: "return=representation" }, headers, init.headers || {}),
    }));
    const body = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body };
  };
}

const LIVE = "status=in.(active,unconfirmed)";
const COLS = "id,kind,text,norm,scope,source_type,source_ref,coach,confidence,status,pending,pending_reason,observed_at,review_after,supersedes,superseded_by,updated_at";

// Apply a plan: inserts one by one (a duplicate fact just gets skipped), then
// updates (supersedes only once their replacement exists), then the audit events.
async function apply(db, plan) {
  const made = new Set(), skipped = [];
  for (const row of plan.inserts) {
    const r = await db("jeetos_memories", { method: "POST", body: JSON.stringify(row) });
    if (r.ok) made.add(row.id); else skipped.push({ id: row.id, status: r.status });
  }
  let updated = 0;
  for (const u of plan.updates) {
    if (u.after && !made.has(u.after)) continue;
    const r = await db(`jeetos_memories?id=eq.${encodeURIComponent(u.id)}`, { method: "PATCH", body: JSON.stringify(u.patch) });
    if (r.ok && Array.isArray(r.body) && r.body.length) updated++;
  }
  const events = plan.events.filter(e => !plan.inserts.some(i => i.id === e.memory_id) || made.has(e.memory_id))
    .filter(e => !(e.detail && e.detail.by) || made.has(e.detail.by));
  if (events.length) await db("jeetos_memory_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(events) });
  return { created: [...made], updated, skipped };
}

module.exports = async function handler(req, res) {
  if (!(await requireOwner(req, res))) return;
  const db = makeDb(req);
  const q = req.query || {};
  try {
    if (req.method === "GET" && q.action === "today") {
      const raw = await loadContextData(async p => { const r = await db(p); return r.ok && Array.isArray(r.body) ? r.body : null; });
      const pk = buildPacket(raw, { coach: "head", purpose: "chat" });
      const health = (raw.graph || []).length ? graphHealth(raw.graph, raw, pk.day) : null;
      const promises = (raw.openPromises || []).filter(c => c.owner !== "coach").map(c => ({ id: c.id, text: c.text, due: c.due, coach: c.coach, staked: !!c.staked, overdue: !!(c.due && c.due < pk.day) }));
      return res.status(200).json({ day: pk.day, nextAction: pk.nextAction, plan: pk.plan, anchors: pk.anchors, primary: health && health.primary, goals: health ? health.goals : [], promises, unknowns: pk.unknowns, unreadable: raw.failed });
    }
    if (req.method === "GET" && q.action === "notify") {
      const day = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
      const [st, log] = await Promise.all([db("jeetos_settings?id=eq.notify&select=data"), db(`jeetos_push_log?day=eq.${day}&select=tag,cls,decision,reason,at&order=at.desc&limit=40`)]);
      return res.status(200).json({ settings: settingsOf(st.ok && st.body && st.body[0] && st.body[0].data), defaults: NOTIFY_DEFAULTS, today: log.ok ? log.body : [] });
    }
    if ((req.method === "GET" && q.action === "checkin") || (req.method === "POST" && (req.body || {}).action === "checkin.save")) {
      const now = Date.now(), day = planDay(now), hour = new Date(now + 330 * 60000).getUTCHours();
      const raw = await loadContextData(async p => { const r = await db(p); return r.ok && Array.isArray(r.body) ? r.body : null; }, now);
      const log = (raw.logs || []).find(l => String(l.day).slice(0, 10) === day) || null;
      const gs = raw.goalState, ctx = { log, todayPriority: gs && gs.today && gs.today.date === day ? gs.today : null, plan: todayPlan(raw, now) };
      const have = k => (raw.dailyCheckins || []).find(c => String(c.day).slice(0, 10) === day && c.kind === k);
      if (req.method === "GET") {
        const kind = ["morning", "evening"].find(k => checkinDue(k, hour) && !have(k)) || null;
        return res.status(200).json({ day, kind, questions: kind ? questionsFor(kind, ctx) : [], done: { morning: !!have("morning"), evening: !!have("evening") } });
      }
      const b = req.body, kind = b.kind;
      if (!["morning", "evening"].includes(kind)) return res.status(400).json({ error: "kind must be morning or evening" });
      // Validate against every question of that kind (he may have logged something meanwhile);
      // only the ones still being asked are required.
      const all = questionsFor(kind, { plan: ctx.plan }, true), asked = questionsFor(kind, ctx).map(x => x.id);
      const c = cleanAnswers(kind, all, b.answers, asked);
      if (c.error) return res.status(400).json({ error: c.error });
      const r = await db("jeetos_daily_checkins?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ id: day + ":" + kind, day, kind, answers: c.answers, updated_at: new Date().toISOString() }) });
      if (!r.ok) return res.status(502).json({ error: "couldn't save (" + r.status + ")" });
      return res.status(200).json({ ok: true, day, kind, answers: c.answers });
    }
    if (req.method === "GET" && q.action === "habits") {
      const raw = await loadContextData(async p => { const r = await db(p); return r.ok && Array.isArray(r.body) ? r.body : null; });
      return res.status(200).json(Object.assign({ day: planDay(Date.now()), unreadable: raw.failed }, habitReport(raw, planDay(Date.now()))));
    }
    if (req.method === "GET" && q.action === "insights") {
      const raw = await loadContextData(async p => { const r = await db(p); return r.ok && Array.isArray(r.body) ? r.body : null; });
      return res.status(200).json(Object.assign({ unreadable: raw.failed }, insightReport(raw, planDay(Date.now()))));
    }
    if (req.method === "GET" && q.action === "journal") {
      const r = await db("jeetos_decisions?status=eq.approved&select=id,coach,area,change,reason,alternatives,expected_outcome,review_on,actual_outcome,verdict,decided_at,outcome_at,source&order=decided_at.desc&limit=60");
      if (!r.ok) return res.status(502).json({ error: "couldn't read decisions (" + r.status + ")" });
      const today = planDay(Date.now());
      return res.status(200).json({ today, decisions: r.body.map(x => Object.assign({}, x, { review_day: reviewDay(x), due: !x.verdict && !!reviewDay(x) && reviewDay(x) <= today })) });
    }
    if ((req.method === "GET" && q.action === "repair") || (req.method === "POST" && /^repair\./.test((req.body || {}).action || ""))) {
      const raw = await loadContextData(async p => { const r = await db(p); return r.ok && Array.isArray(r.body) ? r.body : null; });
      if ((raw.failed || []).includes("schedule")) return res.status(502).json({ error: "couldn't read the schedule" });
      const today = planDay(Date.now()), nowIso = new Date().toISOString(), props = repair.proposals(raw, today);
      if (req.method === "GET") return res.status(200).json({ today, proposals: props, overrides: raw.scheduleOverrides });
      const b = req.body, save = async data => db("jeetos_settings?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ id: "schedule", data, updated_at: nowIso }) });
      if (b.action === "repair.revert") {
        const next = repair.revert(raw.schedule, String(b.anchor || ""), today, nowIso);
        if (!next) return res.status(400).json({ error: "unknown anchor" });
        const r = await save(next);
        return r.ok ? res.status(200).json({ ok: true, from: next.overrides.slice(-1)[0].from }) : res.status(502).json({ error: "couldn't save (" + r.status + ")" });
      }
      const pr = props.find(x => x.id === b.id);
      if (!pr) return res.status(409).json({ error: "this suggestion is no longer valid — refresh" });
      if (b.action === "repair.reject") {
        const r = await save(repair.reject(raw.schedule, pr, nowIso));
        return r.ok ? res.status(200).json({ ok: true }) : res.status(502).json({ error: "couldn't save (" + r.status + ")" });
      }
      if (b.action !== "repair.approve") return res.status(400).json({ error: "unknown action" });
      const next = repair.approve(raw.schedule, pr, today, nowIso), r = await save(next);
      if (!r.ok) return res.status(502).json({ error: "couldn't save (" + r.status + ")" });
      // Into the decision journal, so it gets reviewed in 14 days ("did the new time work?").
      await db("jeetos_decisions", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), coach: "head", area: pr.anchor,
        change: `${pr.label}: ${pr.from_time} → ${pr.to_time} from ${next.overrides.slice(-1)[0].from}`, reason: pr.text.slice(0, 300), evidence: JSON.stringify(pr.evidence).slice(0, 300),
        expected_outcome: `on time for ${pr.label} most days`, source: "repair", status: "approved", created_at: nowIso, decided_at: nowIso }) });
      return res.status(200).json({ ok: true, from: next.overrides.slice(-1)[0].from });
    }
    if ((req.method === "GET" && q.action === "huddle") || (req.method === "POST" && (req.body || {}).action === "huddle.run")) {
      const qq = async p => { const r = await db(p); return r.ok && Array.isArray(r.body) ? r.body : null; };
      if (req.method === "GET") {
        const day = planDay(Date.now()), rows = await qq(`jeetos_huddles?day=eq.${day}&select=*`);
        return res.status(200).json({ day, huddle: rows && rows[0] || null });
      }
      const out = await ensureHuddle({ q: qq, write: (p, body, headers) => db(p, { method: "POST", headers, body: JSON.stringify(body) }), callClaude, source: "app" });
      if (out.error) return res.status(502).json(out);
      return res.status(200).json(out);
    }
    if ((req.method === "GET" && q.action === "review") || (req.method === "POST" && (req.body || {}).action === "review.run")) {
      const qq = async p => { const r = await db(p); return r.ok && Array.isArray(r.body) ? r.body : null; };
      if (req.method === "GET") {
        const want = reviewWeek(planDay(Date.now())).end, rows = await qq("jeetos_weekly_reviews?select=*&order=week_end.desc&limit=4");
        if (!rows) return res.status(502).json({ error: "couldn't read reviews" });
        return res.status(200).json({ latest: rows[0] || null, older: rows.slice(1).map(r => ({ week_end: r.week_end, week_start: r.week_start })), missing: !rows.some(r => String(r.week_end).slice(0, 10) === want), week_end: want });
      }
      const out = await ensureReview({ q: qq, write: (p, body, headers) => db(p, { method: "POST", headers, body: JSON.stringify(body) }), callClaude, source: "app" });
      return res.status(out.error ? 502 : 200).json(out);
    }
    if (req.method === "GET" && q.action === "goals") {
      const raw = await loadContextData(async p => { const r = await db(p); return r.ok && Array.isArray(r.body) ? r.body : null; });
      const all = await db("jeetos_goals?select=id,kind,parent_id,title,why,owner_coach,metric,target,status,approved_at,updated_at&order=created_at.asc");
      if (!all.ok) return res.status(502).json({ error: "couldn't read goals (" + all.status + ")" });
      const health = graphHealth(all.body, raw, planDay(Date.now()));
      const hasPrimary = all.body.some(g => g.kind === "primary" && g.status === "active");
      return res.status(200).json({ goals: all.body, health: health.goals, primary: health.primary, proposal: hasPrimary ? null : PLAN, unreadable: raw.failed });
    }
    if (req.method === "GET") {
      if (q.action !== "memories") return res.status(400).json({ error: "unknown action" });
      if (q.id) {
        const id = String(q.id).replace(/[^a-z0-9]/gi, "").slice(0, 40);
        const [m, ev] = await Promise.all([
          db(`jeetos_memories?id=eq.${id}&select=${COLS}`),
          db(`jeetos_memory_events?memory_id=eq.${id}&select=action,detail,actor,at&order=at.asc&limit=50`),
        ]);
        return res.status(200).json({ memory: (m.body || [])[0] || null, events: ev.body || [] });
      }
      const [live, closed] = await Promise.all([
        db(`jeetos_memories?${LIVE}&select=${COLS}&order=observed_at.desc&limit=200`),
        db(`jeetos_memories?status=in.(superseded,retracted)&select=${COLS}&order=updated_at.desc&limit=30`),
      ]);
      if (!live.ok) return res.status(502).json({ error: "couldn't read memories (" + live.status + ")" });
      return res.status(200).json({ live: live.body, closed: closed.body || [] });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const b = req.body || {};
    if (b.action === "memory.propose") {
      const items = Array.isArray(b.items) ? b.items.slice(0, 8) : [];
      if (!items.length) return res.status(400).json({ error: "items[] required" });
      const live = await db(`jeetos_memories?${LIVE}&select=id,text,norm,scope,pending&limit=500`);
      if (!live.ok) return res.status(502).json({ error: "couldn't read memories (" + live.status + ")" });
      const source = ["tag", "memory_pass", "user"].includes(b.source) ? b.source : "tag";
      const plan = planPropose(live.body, items, { coach: b.coach, source, source_ref: b.source_ref });
      const out = await apply(db, plan);
      return res.status(200).json(Object.assign({ ok: true }, out));
    }
    if (b.action === "memory.act") {
      const id = String(b.id || "").replace(/[^a-z0-9]/gi, "").slice(0, 40);
      const m = await db(`jeetos_memories?id=eq.${id}&select=${COLS}`);
      const mem = (m.body || [])[0];
      if (!mem) return res.status(404).json({ error: "not found" });
      const plan = planAct(mem, b.op, { text: b.text, reason: b.reason });
      if (plan.error) return res.status(400).json({ error: plan.error });
      const out = await apply(db, plan);
      if (plan.inserts.length && !out.created.length) return res.status(409).json({ error: "that fact already exists" });
      return res.status(200).json(Object.assign({ ok: true }, out));
    }
    if (b.action === "notify.set") {
      const want = b.settings || {}, clean = settingsOf(want);
      // Reject instead of silently falling back, so he knows the value didn't stick.
      for (const k of Object.keys(want)) {
        if (!(k in NOTIFY_DEFAULTS) || String(clean[k]) !== String(k in NOTIFY_LIMITS ? Math.round(Number(want[k])) : want[k])) return res.status(400).json({ error: "invalid " + k });
      }
      const r = await db("jeetos_settings?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ id: "notify", data: clean, updated_at: new Date().toISOString() }) });
      if (!r.ok) return res.status(502).json({ error: "couldn't save (" + r.status + ")" });
      return res.status(200).json({ ok: true, settings: clean });
    }
    if (b.action === "journal.add" || b.action === "journal.outcome") {
      const txt = (v, n) => (v == null ? null : String(v).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, n) || null);
      const now = new Date().toISOString(), today = planDay(Date.now());
      if (b.action === "journal.add") {
        const change = txt(b.change, 300);
        if (!change || change.length < 4) return res.status(400).json({ error: "write the decision" });
        let review = b.review_on ? String(b.review_on).slice(0, 10) : null;
        if (review && (!/^\d{4}-\d{2}-\d{2}$/.test(review) || review <= today || review > (new Date(Date.now() + 180 * 864e5).toISOString().slice(0, 10)))) return res.status(400).json({ error: "review date must be within the next 6 months" });
        const row = { id: "j" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), coach: "jeet", area: txt(b.area, 40), change, reason: txt(b.reason, 300), alternatives: txt(b.alternatives, 300),
          expected_outcome: txt(b.expected, 300), review_on: review, source: "journal", status: "approved", created_at: now, decided_at: now };
        const r = await db("jeetos_decisions", { method: "POST", body: JSON.stringify(row) });
        if (!r.ok) return res.status(502).json({ error: "couldn't save (" + r.status + ")" });
        return res.status(200).json({ ok: true, id: row.id });
      }
      if (!["worked", "didnt", "unclear"].includes(b.verdict)) return res.status(400).json({ error: "verdict must be worked, didnt or unclear" });
      const id = String(b.id || "").replace(/[^a-z0-9]/gi, "").slice(0, 40);
      const cur = ((await db(`jeetos_decisions?id=eq.${id}&select=id,status,verdict`)).body || [])[0];
      if (!cur || cur.status !== "approved") return res.status(404).json({ error: "not found" });
      const r = await db(`jeetos_decisions?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ verdict: b.verdict, actual_outcome: txt(b.actual, 300), outcome_at: now }) });
      if (!r.ok) return res.status(502).json({ error: "couldn't save (" + r.status + ")" });
      return res.status(200).json({ ok: true });
    }
    if (b.action === "goals.approve") {
      const all = await db("jeetos_goals?select=id,status");
      if (!all.ok) return res.status(502).json({ error: "couldn't read goals (" + all.status + ")" });
      const now = new Date().toISOString();
      const rows = approvalRows(all.body, now);
      // Primary first (the supporting goals point at it).
      const made = [];
      for (const row of rows.sort((a, c) => (a.kind === "primary" ? -1 : 1) - (c.kind === "primary" ? -1 : 1))) {
        const r = await db("jeetos_goals", { method: "POST", body: JSON.stringify(row) });
        if (r.ok) made.push(row.id);
      }
      if (made.length) await db("jeetos_goal_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(made.map(id => ({ goal_id: id, action: "approve", actor: "jeet", detail: {} }))) });
      return res.status(200).json({ ok: true, created: made });
    }
    if (b.action === "goals.target" || b.action === "goals.cancel" || b.action === "goals.resume") {
      const id = String(b.id || "").replace(/[^a-z0-9_]/g, "").slice(0, 40);
      const g = ((await db(`jeetos_goals?id=eq.${id}&select=id,kind,status,target`)).body || [])[0];
      if (!g) return res.status(404).json({ error: "not found" });
      let patch, detail;
      if (b.action === "goals.target") {
        const t = cleanTarget(g, b.target);
        if (!t) return res.status(400).json({ error: "target out of range" });
        patch = { target: t }; detail = { from: g.target, to: t };
      } else if (b.action === "goals.cancel") {
        if (g.status !== "active") return res.status(400).json({ error: "not active" });
        patch = { status: "cancelled" }; detail = { reason: String(b.reason || "").slice(0, 200) || null };
      } else {
        if (g.status !== "cancelled") return res.status(400).json({ error: "not cancelled" });
        patch = { status: "active" }; detail = {};
      }
      const r = await db(`jeetos_goals?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(Object.assign(patch, { updated_at: new Date().toISOString() })) });
      if (!r.ok) return res.status(502).json({ error: "update failed (" + r.status + ")" });
      await db("jeetos_goal_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ goal_id: id, action: b.action.split(".")[1], actor: "jeet", detail }]) });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 200) });
  }
};
