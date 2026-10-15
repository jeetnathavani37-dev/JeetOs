// api/penalty.js — accountability ledger (SIMULATION: no money moves).
//   GET  (Vercel Cron, Bearer CRON_SECRET)        → run the engine
//   POST { action: "confirm_policy" }  (owner)    → activate policy v1 (server-defined rules)
//   POST { action: "stake", commitment_id, time } → stake one of his own open promises
//   POST { action: "unstake", commitment_id }     → undo within 10 min of staking
//   POST { action: "run" }             (owner)    → run the engine now
//   POST { action: "go_live", confirm: "LIVE" }    → real-money mode (new policy version from now)
//   POST { action: "dues" | "settle_start" }      → what's owed (live entries − paid) / pay it
//   POST { action: "plan_rest" | "cancel_rest", date } → plan a gym rest day (monthly pass) ahead
//   POST { action: "evidence", date, proof_key, vault_key, sha256 } → record a proof photo's arrival
//   POST { action: "weighin", kg, fasted, morning, supersedes? } / { action: "goal_start" | "goal_cancel" } → weight milestone
//   POST { action: "checkin", anchor, client_at, lat?, lng?, acc? } / { action: "set_place", place, lat, lng, acc } → daily anchors
//   POST { action: "dispute", incident_id, category, reason, photo? } → pause the fine, AI review, rules decide
//   POST { action: "set_payee" | "pay_test_start" | "pay_report" | "pay_cancel" } → manual UPI
//        (₹1 test to the charity; he pays in his own UPI app; status is self-reported)
// The client can only read the ledger; every write happens here with the
// server key, and amounts come only from api/_penalty.js.
const { requireOwner, SUPABASE_URL } = require("./_auth");
const { POLICY_V1, plan, istDate, istAt, addDays, rupees, exceptionCandidates, exceptionExtras, disputeOutcome, WEIGHT_RULES, weightPlan, anchorCandidates, anchorExtras } = require("./_penalty");
const crypto = require("crypto");
const { sendToAll } = require("./_push");

const KEY = () => (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "").trim();
async function db(path, init = {}) {
  const key = KEY();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, Object.assign({}, init, {
    headers: Object.assign({ apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }, init.headers || {}),
  }));
  const text = await r.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
  if (!r.ok) { const e = new Error(`db ${r.status}: ${typeof body === "object" && body ? body.message || JSON.stringify(body) : body}`); e.status = r.status; throw e; }
  return body;
}
const audit = (entity, entity_id, action, detail, actor = "engine") =>
  db("jeetos_audit_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ entity, entity_id, action, detail, actor }) });

async function activePolicy() {
  const rows = await db("jeetos_penalty_policies?status=eq.active&order=version.desc&limit=1&select=*");
  const p = rows && rows[0];
  return p ? Object.assign({}, p.rules, { version: p.version, mode: p.mode, effective_from: p.effective_from }) : null;
}

// Money owed = entries assessed under a LIVE policy − settlements he reported paid.
// Simulation-mode entries are never payable.
async function dues() {
  const live = await db("jeetos_penalty_policies?mode=eq.live&select=version");
  const vers = (live || []).map(p => p.version);
  if (!vers.length) return { live: false, assessed_paise: 0, paid_paise: 0, dues_paise: 0 };
  const [ent, pays, disputed] = await Promise.all([
    db(`jeetos_penalty_entries?policy_version=in.(${vers.join(",")})&select=incident_id,amount_paise&limit=10000`),
    db("jeetos_payments?kind=eq.settlement&status=in.(reported_paid,verified)&select=amount_paise"),
    db("jeetos_penalty_incidents?status=eq.disputed&select=id"),
  ]);
  const paused = new Set((disputed || []).map(i => i.id));   // a disputed fine isn't owed until it's decided
  const assessed = ent.filter(e => !paused.has(e.incident_id)).reduce((a, e) => a + Number(e.amount_paise), 0), paid = pays.reduce((a, x) => a + Number(x.amount_paise), 0);
  return { live: true, assessed_paise: assessed, paid_paise: paid, dues_paise: Math.max(0, assessed - paid) };
}
// For _push.sendToAll, which expects a fetch-style helper.
const rawDb = (path, init = {}) => { const key = KEY(); return fetch(`${SUPABASE_URL}/rest/v1/${path}`, Object.assign({}, init, { headers: Object.assign({ apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }, init.headers || {}) })); };
// Sunday (after noon IST): one settle-up notice per day if anything is unpaid.
async function sundayNotice(now) {
  const ist = new Date(now + 330 * 60000);
  if (ist.getUTCDay() !== 0 || ist.getUTCHours() < 12) return null;
  const d = await dues();
  if (!d.dues_paise) return null;
  const [payee] = await db("jeetos_payees?id=eq.charity&select=name") || [];
  const text = `Hafte ka hisaab: ${rupees(d.dues_paise)} ${payee ? payee.name : "charity"} ko dena baaki hai. Today → ⚖️ Ledger → Pay karo, phir UTR daal do. Koi galat fine lage toh pehle bata — dispute kar lenge.`;
  const ins = await db("jeetos_coach_inbox?on_conflict=coach,slot,created_on", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ coach: "ronaldo", slot: "settle", text, created_on: istDate(now) }) }).catch(() => []);
  if (!ins || !ins.length) return { notice: "already sent today" };
  const push = await sendToAll(rawDb, { title: "⚖️ Ledger", body: text.slice(0, 180), url: "/", tag: "settle-" + istDate(now) }).catch(e => ({ error: e.message }));
  return { notice: "sent", dues: rupees(d.dues_paise), push };
}

async function runEngine(now = Date.now()) {
  // One run at a time: a short lease row (cron retries / a manual run can't overlap).
  const until = new Date(now + 120000).toISOString();
  const lease = await db(`jeetos_engine_lock?id=eq.penalty&locked_until=lt.${encodeURIComponent(new Date(now).toISOString())}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ locked_until: until }) });
  if (!lease || !lease.length) return { skipped: "another run in progress" };
  try {
    const policy = await activePolicy();
    if (!policy) return { skipped: "no confirmed policy" };
    // Schedule changes he approved (each applies only from its own date on).
    const sched = await db("jeetos_settings?id=eq.schedule&select=data").catch(() => []);
    policy.schedule_overrides = (sched && sched[0] && sched[0].data && sched[0].data.overrides) || [];
    const from = istDate(policy.effective_from);
    const [commitments, logs, entries, incidents] = await Promise.all([
      db("jeetos_commitments?staked=eq.true&select=id,coach,text,due,status,owner,staked,agreed_at,deadline_at,done_at,resolved_at"),
      db(`jeetos_logs?day=gte.${from}&select=date,day,entries,entries_seen,gym_done,total_cal,junk_meals,sleep_hours,bedtime`),
      db("jeetos_penalty_entries?select=incident_id,kind,local_date,amount_paise&limit=10000"),
      db("jeetos_penalty_incidents?select=id,root_key,status&limit=5000"),
    ]);
    // Gym / diet / sleep: a miss uses a monthly pass first (atomic DB function); money only after they run out.
    const [marks, uses] = await Promise.all([
      db(`jeetos_streak_marks?date=gte.${addDays(from, -7)}&select=date,habit,kind,reason`),
      db(`jeetos_allowance_uses?status=eq.used&day=gte.${from}&select=category,day,kind,status`),
    ]);
    const lockedIds = new Set(incidents.filter(i => ["disputed", "excused"].includes(i.status)).map(i => i.id));
    const cands = exceptionCandidates({ policy, logs, marks, uses, now }).filter(c => !lockedIds.has(c.category + ":" + c.date));
    const decided = [];
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (c.state !== "needs_allowance") continue;
      const a = await db("rpc/jeetos_use_allowance", { method: "POST", body: JSON.stringify({ p_category: c.category, p_day: c.date, p_kind: "auto", p_incident: c.category + ":" + c.date, p_limit: policy.exceptions[c.category].monthly_allowance }) });
      decided[i] = { allowance: a };
    }
    // Weight milestone (only once a goal exists).
    const [goal] = await db("jeetos_weight_goals?status=neq.cancelled&order=requested_at.desc&limit=1&select=*") || [];
    let weightExtras = [];
    if (goal) {
      const weighins = await db(`jeetos_weighins?day=gte.${addDays(istDate(goal.requested_at), -14)}&select=id,day,kg,fasted,morning,measured_at,supersedes&order=measured_at.asc`);
      const wp = weightPlan({ goal, weighins, logs, entries, now, version: policy.version });
      if (wp.patch) {
        await db(`jeetos_weight_goals?id=eq.${encodeURIComponent(goal.id)}`, { method: "PATCH", body: JSON.stringify(Object.assign({}, wp.patch, { updated_at: new Date(now).toISOString() })) });
        await audit("weight_goal", goal.id, "status", wp.patch);
      }
      weightExtras = wp.extras.filter(x => !lockedIds.has(x.incident.id));
    }
    // Timed anchors: late inside the extension → that anchor's monthly pass; after it → ₹100.
    let anchorX = [];
    if (policy.anchors) {
      const checkins = await db(`jeetos_anchor_checkins?day=gte.${from}&select=anchor,day,at,client_at,verified&order=at.asc`);
      const ac = anchorCandidates({ policy, checkins, logs, marks, now }).filter(c => !lockedIds.has("anchor:" + c.key + ":" + c.date));
      const adec = [];
      for (let i = 0; i < ac.length; i++) {
        if (ac[i].state !== "needs_allowance") continue;
        adec[i] = { allowance: await db("rpc/jeetos_use_allowance", { method: "POST", body: JSON.stringify({ p_category: "a_" + ac[i].key, p_day: ac[i].date, p_kind: "auto", p_incident: "anchor:" + ac[i].key + ":" + ac[i].date, p_limit: policy.anchors.passes }) }) };
      }
      anchorX = anchorExtras(policy, ac, adec);
    }
    const out = plan({ policy, commitments, logs, entries, incidents, now, extra: exceptionExtras(policy, cands, decided).concat(weightExtras, anchorX) });
    // Review / dispute outcomes are never overwritten by the engine.
    const locked = new Set(incidents.filter(i => ["disputed", "excused"].includes(i.status)).map(i => i.id));
    const incRows = out.incidents.filter(i => !locked.has(i.id)).map(i => Object.assign({}, i, { updated_at: new Date(now).toISOString() }));
    if (incRows.length) await db("jeetos_penalty_incidents?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(incRows) });
    const fresh = out.entries.filter(e => !locked.has(e.incident_id));
    let inserted = [];
    if (fresh.length) inserted = await db("jeetos_penalty_entries?on_conflict=incident_id,kind,local_date", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(fresh) }) || [];
    for (const e of inserted) await audit("penalty_entry", String(e.id), "assessed", { incident_id: e.incident_id, amount_paise: e.amount_paise, local_date: e.local_date, mode: policy.mode });
    const notice = policy.mode === "live" ? await sundayNotice(now).catch(e => ({ error: e.message })) : null;
    return { policy: policy.version, mode: policy.mode, incidents: incRows.length, assessed: inserted.map(e => ({ incident: e.incident_id, date: e.local_date, amount: rupees(Number(e.amount_paise)) })), notice };
  } finally {
    await db("jeetos_engine_lock?id=eq.penalty", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ locked_until: "1970-01-01T00:00:00Z" }) }).catch(() => {});
  }
}


// ── Dispute review (AI recommends, the rules above decide) ──
const REVIEW_MODEL = (process.env.CLAUDE_CHAT_MODEL || "claude-sonnet-5-5").trim();
async function reviewDispute(ctx, image) {
  const key = (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_KEY || "").trim();
  if (!key) return null;
  const system = `You review a disputed entry in Jeet's personal accountability ledger (JeetOS). You are a fair reviewer of evidence, not a judge of his character.
Return ONLY JSON: {"recommendation":"uphold"|"reject"|"need_more","why":"1-3 short lines in simple Hinglish","evidence_used":["..."]}.
Rules:
- uphold when the records or the photo plausibly show he did it in time; when a technical/sync/app problem is plausible (e.g. logged on the phone in time but synced late, app outage, upload failed); when he was genuinely ill or injured on a gym/diet/sleep day (his self-report is accepted — remind him to mark a recovery day next time); or when the rule was applied to the wrong day/data.
- reject ONLY when the records clearly contradict his claim. Never reject because it "sounds like an excuse", because he has disputed before, or for tone. Say exactly what evidence would change the outcome.
- need_more when one specific piece of evidence would decide it; name it.
- A photo shows what it shows — don't claim certainty beyond it (it can't prove reps, calories or timing by itself). Missing photo is not proof he didn't do it.
- Never mention amounts other than those in the data. Never shame.`;
  const content = [{ type: "text", text: JSON.stringify(ctx, null, 1).slice(0, 12000) }];
  if (image) { const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(image); if (m) content.unshift({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }); }
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: REVIEW_MODEL, max_tokens: 1200, system, messages: [{ role: "user", content }] }) });
    const d = await r.json().catch(() => ({}));
    const text = r.ok && Array.isArray(d.content) ? d.content.filter(b => b.type === "text").map(b => b.text).join("") : "";
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (_) { return null; }
}

module.exports = async function handler(req, res) {
  if (!KEY()) return res.status(503).json({ error: "Server key missing — add SUPABASE_SERVICE_ROLE_KEY in Vercel" });
  try {
    if (req.method === "GET") {
      const secret = process.env.CRON_SECRET;
      if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "Unauthorized" });
      return res.status(200).json(await runEngine());
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (!(await requireOwner(req, res))) return;
    const { action, commitment_id, time } = req.body || {};
    const now = Date.now();

    if (action === "confirm_policy") {
      const cur = await activePolicy();
      if (cur) return res.status(200).json({ ok: true, version: cur.version, already: true });
      const row = { version: POLICY_V1.version, mode: POLICY_V1.mode, rules: POLICY_V1, status: "active", confirmed_at: new Date(now).toISOString(), effective_from: new Date(now).toISOString() };
      await db("jeetos_penalty_policies?on_conflict=version", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
      await audit("penalty_policy", String(row.version), "confirmed", { mode: row.mode, caps: POLICY_V1.caps }, "owner");
      return res.status(200).json({ ok: true, version: row.version });
    }

    if (action === "stake" || action === "unstake") {
      if (!commitment_id) return res.status(400).json({ error: "commitment_id required" });
      const policy = await activePolicy();
      if (!policy) return res.status(409).json({ error: "Pehle rules confirm karo" });
      const [c] = await db(`jeetos_commitments?id=eq.${encodeURIComponent(commitment_id)}&select=*`) || [];
      if (!c) return res.status(404).json({ error: "Promise nahi mila (sync hone do)" });
      if (action === "unstake") {
        if (!c.staked) return res.status(200).json({ ok: true });
        if (now - Date.parse(c.agreed_at) > 10 * 60000) return res.status(409).json({ error: "Stake 10 min ke baad hata nahi sakte — dispute karo" });
        await db(`jeetos_commitments?id=eq.${encodeURIComponent(c.id)}`, { method: "PATCH", body: JSON.stringify({ staked: false, agreed_at: null, deadline_at: null, policy_version: null }) });
        await audit("commitment", c.id, "unstaked", {}, "owner");
        return res.status(200).json({ ok: true });
      }
      if (c.staked) return res.status(200).json({ ok: true, already: true, deadline_at: c.deadline_at });
      if (c.owner === "coach") return res.status(400).json({ error: "Ye coach ka promise hai, tumhara nahi" });
      if (c.status !== "open") return res.status(400).json({ error: "Ye promise already band hai" });
      const hm = /^([01]\d|2[0-3]):[0-5]\d$/.test(time || "") ? time : "23:00";
      const deadline = istAt(String(c.due).slice(0, 10), hm);
      if (!(deadline > now + 30 * 60000)) return res.status(400).json({ error: "Deadline kam se kam 30 min aage honi chahiye" });
      const patch = { staked: true, agreed_at: new Date(now).toISOString(), deadline_at: new Date(deadline).toISOString(), policy_version: policy.version };
      await db(`jeetos_commitments?id=eq.${encodeURIComponent(c.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      await audit("commitment", c.id, "staked", { deadline_at: patch.deadline_at, base: rupees(policy.promise.base_paise), mode: policy.mode }, "owner");
      return res.status(200).json(Object.assign({ ok: true }, patch));
    }

    if (action === "run") return res.status(200).json(await runEngine(now));

    // ── Manual UPI (he pays with his own PIN in his UPI app; nothing is auto-debited) ──
    const { name, vpa, source_confirmed, payment_id, utr } = req.body || {};
    if (action === "set_payee") {
      const v = String(vpa || "").trim(), n = String(name || "").trim().slice(0, 80);
      if (!/^[A-Za-z0-9._-]{2,255}@[A-Za-z][A-Za-z0-9.]{1,63}$/.test(v)) return res.status(400).json({ error: "UPI ID sahi format mein nahi hai (jaise name@bank)" });
      if (!n) return res.status(400).json({ error: "Charity ka naam daalo" });
      if (source_confirmed !== true) return res.status(400).json({ error: "Confirm karo ki UPI ID charity ki official site se liya hai" });
      const pending = await db("jeetos_payments?status=eq.initiated&select=id");
      if (pending.length) return res.status(409).json({ error: "Pehle chal raha payment complete ya cancel karo" });
      await db("jeetos_payees?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ id: "charity", name: n, vpa: v, source_confirmed: true, updated_at: new Date(now).toISOString() }) });
      await audit("payee", "charity", "set", { name: n, vpa: v }, "owner");
      return res.status(200).json({ ok: true });
    }
    if (action === "dues") return res.status(200).json(await dues());

    // ── Daily anchors: check-ins (server time) + saved gym / library location ──
    if (action === "set_place") {
      const { place, lat, lng, acc } = req.body || {};
      if (!["gym", "work"].includes(place) || !isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: "Location nahi mili" });
      if (isFinite(acc) && acc > 200) return res.status(400).json({ error: "Location accurate nahi hai (" + Math.round(acc) + " m) — bahar/khidki ke paas try karo" });
      await db("jeetos_places?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ id: place, lat: +lat, lng: +lng, accuracy_m: isFinite(acc) ? +acc : null, set_at: new Date(now).toISOString() }) });
      await audit("place", place, "set", { accuracy_m: acc }, "owner");
      return res.status(200).json({ ok: true });
    }
    if (action === "checkin") {
      const { anchor, client_at, lat, lng, acc } = req.body || {};
      const pol = await activePolicy(), AN = (pol && pol.anchors) || POLICY_V1.anchors, A = AN && AN.list[anchor];
      if (!A || A.kind !== "checkin") return res.status(400).json({ error: "Ye check-in nahi hai" });
      const istHour = new Date(now + 330 * 60000).getUTCHours();
      const day = A.next_day && istHour < 12 ? istDate(now - 864e5) : istDate(now);
      const todays = await db(`jeetos_anchor_checkins?day=eq.${day}&anchor=eq.${anchor}&select=id`);
      if (todays.length >= 3) return res.status(429).json({ error: "Aaj ye check-in ho chuka" });
      let distance = null, verified = null;
      if (A.place) {
        const [pl] = await db(`jeetos_places?id=eq.${A.place}&select=lat,lng`) || [];
        if (pl && isFinite(lat) && isFinite(lng)) {
          const R = 6371000, dLat = (lat - pl.lat) * Math.PI / 180, dLng = (lng - pl.lng) * Math.PI / 180;
          const h = Math.sin(dLat / 2) ** 2 + Math.cos(pl.lat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
          distance = Math.round(2 * R * Math.asin(Math.sqrt(h)));
          verified = distance <= 400 + Math.min(isFinite(acc) ? +acc : 0, 200);
          if (!verified) return res.status(409).json({ error: (A.place === "gym" ? "Gym" : "Library") + " se " + (distance >= 1000 ? (distance / 1000).toFixed(1) + " km" : distance + " m") + " door ho — wahan pahunch ke check-in karo", distance_m: distance });
        }
      }
      const c = client_at && Math.abs(Date.parse(client_at) - now) < 3 * 864e5 ? new Date(Date.parse(client_at)).toISOString() : null;
      const row = { id: "ck_" + now.toString(36) + crypto.randomBytes(2).toString("hex"), anchor, day, client_at: c, lat: isFinite(lat) ? +lat : null, lng: isFinite(lng) ? +lng : null,
        accuracy_m: isFinite(acc) ? +acc : null, distance_m: distance, verified };
      await db("jeetos_anchor_checkins", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
      return res.status(200).json({ ok: true, checkin: Object.assign({ at: new Date(now).toISOString() }, row) });
    }

    // ── Weight: weigh-ins (server time, append-only) and the 12-week goal ──
    if (action === "weighin") {
      const { kg, fasted, morning, note, supersedes } = req.body || {};
      const v = Math.round(Number(kg) * 100) / 100;
      if (!(v > 25 && v < 300)) return res.status(400).json({ error: "Weight 25–300 kg ke beech daalo" });
      const today = istDate(now);
      const todays = await db(`jeetos_weighins?day=eq.${today}&select=id`);
      if (todays.length >= 3) return res.status(429).json({ error: "Aaj 3 weigh-ins ho chuke" });
      const row = { id: "w_" + now.toString(36) + crypto.randomBytes(2).toString("hex"), day: today, kg: v, fasted: fasted === true, morning: morning === true,
        source: "app", note: note ? String(note).slice(0, 200) : null, supersedes: supersedes ? String(supersedes).slice(0, 40) : null };
      await db("jeetos_weighins", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
      await audit("weighin", row.id, supersedes ? "corrected" : "recorded", { kg: v, fasted: row.fasted, morning: row.morning, supersedes: row.supersedes }, "owner");
      return res.status(200).json({ ok: true, weighin: row });
    }
    if (action === "goal_start" || action === "goal_cancel") {
      const [g] = await db("jeetos_weight_goals?status=in.(baseline,active,extension)&order=requested_at.desc&limit=1&select=*") || [];
      if (action === "goal_cancel") {
        if (!g) return res.status(404).json({ error: "Koi chalta goal nahi hai" });
        const fresh = g.status === "baseline" || (g.start_day && istDate(now) <= addDays(String(g.start_day), 7));
        if (!fresh) return res.status(409).json({ error: "Goal shuru hue 7 din ho gaye — ab cancel nahi, dispute ya review hi hoga" });
        await db(`jeetos_weight_goals?id=eq.${encodeURIComponent(g.id)}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled", updated_at: new Date(now).toISOString() }) });
        await audit("weight_goal", g.id, "cancelled", {}, "owner");
        return res.status(200).json({ ok: true });
      }
      if (g) return res.status(409).json({ error: "Ek goal pehle se chal raha hai" });
      if (!(await activePolicy())) return res.status(409).json({ error: "Pehle rules confirm karo" });
      const row = { id: "wg_" + now.toString(36), status: "baseline", requested_at: new Date(now).toISOString(), target_loss_kg: WEIGHT_RULES.loss_kg,
        weeks: WEIGHT_RULES.weeks, ext_weeks: WEIGHT_RULES.ext_weeks, plan: String((req.body || {}).plan || "Coaches ka approved plan: ~1,800 kcal, gym Mon–Sat, 7h+ sleep").slice(0, 500), rules: WEIGHT_RULES };
      await db("jeetos_weight_goals", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
      await audit("weight_goal", row.id, "requested", { rules: WEIGHT_RULES }, "owner");
      return res.status(200).json({ ok: true, goal: row });
    }

    // Proof photo evidence: the photo itself is encrypted in his vault; the server records when it arrived.
    if (action === "evidence") {
      const { date, proof_key, vault_key, sha256 } = req.body || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^[a-z0-9_]{1,40}$/i.test(proof_key || "") || !/^[0-9a-f]{64}$/.test(sha256 || "")) return res.status(400).json({ error: "bad evidence" });
      const id = "ev_" + sha256.slice(0, 24);
      await db("jeetos_evidence?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({ id, kind: "proof_photo", day: date, proof_key, vault_key: String(vault_key || "").slice(0, 120) || null, sha256 }) });
      return res.status(200).json({ ok: true, id });
    }

    // Dispute: pauses the fine at once, then an AI review recommends and the rules decide.
    if (action === "dispute") {
      const { incident_id, category, reason, photo, vault_key } = req.body || {};
      const cats = ["tech_issue", "did_it", "wrong_data", "ill", "other"];
      if (!cats.includes(category)) return res.status(400).json({ error: "Wajah ka type chuno" });
      if (String(reason || "").trim().length < 10) return res.status(400).json({ error: "Thoda detail mein likho kya hua (10+ characters)" });
      if (photo && (typeof photo !== "string" || photo.length > 3e6 || !/^data:image\//.test(photo))) return res.status(400).json({ error: "Photo sahi nahi hai" });
      const [inc] = await db(`jeetos_penalty_incidents?id=eq.${encodeURIComponent(incident_id || "")}&select=*`) || [];
      if (!inc) return res.status(404).json({ error: "Ye entry nahi mili" });
      const prior = await db(`jeetos_disputes?incident_id=eq.${encodeURIComponent(inc.id)}&select=id,status,category,reason,review,prev_status,created_at&order=created_at.asc`);
      if (prior.some(d => d.status === "open")) return res.status(409).json({ error: "Is par ek dispute pehle se chal raha hai" });
      if (prior.length >= 2) return res.status(409).json({ error: "Is entry par 2 baar dispute ho chuka — ab ye final hai" });
      const id = "dp_" + now.toString(36) + crypto.randomBytes(3).toString("hex");
      const prevStatus = inc.status === "disputed" ? (prior.length ? prior[prior.length - 1].prev_status : "resolved") : inc.status;
      const dispute = { id, incident_id: inc.id, category, reason: String(reason).trim().slice(0, 1000), prev_status: prevStatus, status: "open" };
      await db("jeetos_disputes", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(dispute) });
      await db(`jeetos_penalty_incidents?id=eq.${encodeURIComponent(inc.id)}`, { method: "PATCH", body: JSON.stringify({ status: "disputed", updated_at: new Date(now).toISOString() }) });
      await audit("dispute", id, "opened", { incident_id: inc.id, category, prev_status: prevStatus }, "owner");
      let evId = null;
      if (photo) {
        const sha = crypto.createHash("sha256").update(photo).digest("hex");
        evId = "ev_" + sha.slice(0, 24);
        await db("jeetos_evidence?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
          body: JSON.stringify({ id: evId, kind: "dispute_photo", day: (inc.detail && inc.detail.date) || null, vault_key: String(vault_key || "").slice(0, 120) || null, sha256: sha, incident_id: inc.id, dispute_id: id }) });
      }
      // Everything the reviewer may look at.
      const day = (inc.detail && inc.detail.date) || null;
      const [ents, evid, logRow, commit] = await Promise.all([
        db(`jeetos_penalty_entries?incident_id=eq.${encodeURIComponent(inc.id)}&select=*&order=id.asc`),
        day ? db(`jeetos_evidence?day=eq.${day}&select=kind,proof_key,received_at`) : Promise.resolve([]),
        day ? db(`jeetos_logs?day=eq.${day}&select=gym_done,total_cal,junk_meals,sleep_hours,bedtime,entries,entries_seen`) : Promise.resolve([]),
        inc.commitment_id ? db(`jeetos_commitments?id=eq.${encodeURIComponent(inc.commitment_id)}&select=text,due,deadline_at,agreed_at,status,done_at,resolved_at`) : Promise.resolve([]),
      ]);
      const review = await reviewDispute({
        incident: { title: inc.title, category: inc.category, status_before: prevStatus, detail: inc.detail },
        assessed: ents.filter(e => e.kind !== "reversal").map(e => ({ date: e.local_date, amount: rupees(Number(e.amount_paise)), why: e.calc && e.calc.why, checkpoint: e.calc && e.calc.checkpoint })),
        dispute: { type: category, his_words: dispute.reason, attempt: prior.length + 1, earlier: prior.map(d => ({ type: d.category, outcome: d.status, why: d.review && d.review.why })) },
        records_that_day: logRow[0] || null, proof_photos_that_day: evid, promise: commit[0] || null, photo_attached: !!photo,
      }, photo);
      const out = disputeOutcome(review, dispute, ents, istDate(now));
      if (out.reversals.length) await db("jeetos_penalty_entries?on_conflict=incident_id,kind,local_date", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(out.reversals) });
      if (out.releasePass) await db(`jeetos_allowance_uses?incident_id=eq.${encodeURIComponent(inc.id)}&status=eq.used`, { method: "PATCH", body: JSON.stringify({ status: "released", released_at: new Date(now).toISOString() }) });
      await db(`jeetos_penalty_incidents?id=eq.${encodeURIComponent(inc.id)}`, { method: "PATCH", body: JSON.stringify({ status: out.incident, updated_at: new Date(now).toISOString() }) });
      await db(`jeetos_disputes?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: out.dispute, review: Object.assign({}, review || { error: "review unavailable — fine stays paused" }, { prev_status: prevStatus, model: REVIEW_MODEL }), decided_at: out.dispute === "open" ? null : new Date(now).toISOString() }) });
      if (evId) await db(`jeetos_evidence?id=eq.${evId}`, { method: "PATCH", body: JSON.stringify({ status: out.dispute === "upheld" ? "accepted" : out.dispute === "rejected" ? "rejected" : "insufficient", ai_analysis: review }) }).catch(() => {});
      await audit("dispute", id, out.dispute, { incident_id: inc.id, recommendation: review && review.recommendation, why: review && review.why, reversed_paise: out.reversals.reduce((a, r) => a - r.amount_paise, 0) }, "review");
      return res.status(200).json({ ok: true, dispute_id: id, outcome: out.dispute, why: review && review.why, reversed: rupees(out.reversals.reduce((a, r) => a - r.amount_paise, 0)) });
    }
    // Plan a gym rest day ahead (uses one of the month's 7 passes) or cancel an unused one.
    if (action === "plan_rest" || action === "cancel_rest") {
      const policy = await activePolicy();
      if (!policy || !policy.exceptions) return res.status(409).json({ error: "Pehle rules confirm karo" });
      const day = String((req.body || {}).date || "");
      const today = istDate(now);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < today || day > addDays(today, 14)) return res.status(400).json({ error: "Aaj se 14 din ke andar ki date chuno" });
      if (action === "cancel_rest") {
        if (day === today && Date.now() > istAt(today, "06:00")) return res.status(409).json({ error: "Aaj ka rest subah 6 baje ke baad cancel nahi hota" });
        const r = await db("rpc/jeetos_release_allowance", { method: "POST", body: JSON.stringify({ p_category: "gym", p_day: day }) });
        if (!r.ok) return res.status(409).json({ error: "Ye rest day cancel nahi ho sakta (already use ho chuka)" });
        await audit("allowance", "gym:" + day, "rest_cancelled", {}, "owner");
        return res.status(200).json({ ok: true });
      }
      const wd = new Date(day + "T12:00:00Z").getUTCDay();
      if (!policy.exceptions.gym.days.includes(wd)) return res.status(400).json({ error: "Sunday already rest day hai — pass ki zaroorat nahi" });
      const r = await db("rpc/jeetos_use_allowance", { method: "POST", body: JSON.stringify({ p_category: "gym", p_day: day, p_kind: "planned", p_incident: null, p_limit: policy.exceptions.gym.monthly_allowance }) });
      if (!r.ok) return res.status(409).json({ error: "Is mahine ke " + policy.exceptions.gym.monthly_allowance + " rest passes khatam" });
      await audit("allowance", "gym:" + day, "rest_planned", { used: r.used }, "owner");
      return res.status(200).json(Object.assign({ ok: true }, r));
    }
    // Switching to real money needs his explicit typed confirmation. A new policy version starts now;
    // nothing assessed in simulation becomes payable, and promises staked before need re-staking.
    if (action === "go_live") {
      if ((req.body || {}).confirm !== "LIVE") return res.status(400).json({ error: "Confirm karne ke liye LIVE type karo" });
      const cur = await activePolicy();
      if (!cur) return res.status(409).json({ error: "Pehle rules confirm karo" });
      if (cur.mode === "live") return res.status(200).json({ ok: true, already: true, version: cur.version });
      const [payee] = await db("jeetos_payees?id=eq.charity&select=name") || [];
      if (!payee) return res.status(409).json({ error: "Pehle charity save karo" });
      const all = await db("jeetos_penalty_policies?select=version&order=version.desc&limit=1");
      const version = (all[0] ? all[0].version : 0) + 1, ts = new Date(now).toISOString();
      await db(`jeetos_penalty_policies?version=eq.${cur.version}`, { method: "PATCH", body: JSON.stringify({ status: "retired" }) });
      await db("jeetos_penalty_policies", { method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ version, mode: "live", rules: Object.assign({}, POLICY_V1, { version, mode: "live" }), status: "active", confirmed_at: ts, effective_from: ts }) });
      await audit("penalty_policy", String(version), "went_live", { from_version: cur.version, caps: POLICY_V1.caps, payee: payee.name }, "owner");
      return res.status(200).json({ ok: true, version });
    }
    if (action === "settle_start") {
      const d = await dues();
      if (!d.live) return res.status(409).json({ error: "Abhi simulation mode hai — koi asli dues nahi" });
      const pending = await db("jeetos_payments?status=eq.initiated&select=*");
      if (pending.length) return res.status(200).json({ payment: pending[0] });
      if (!d.dues_paise) return res.status(409).json({ error: "Kuch baaki nahi hai 🎉" });
      const [payee] = await db("jeetos_payees?id=eq.charity&select=*") || [];
      if (!payee) return res.status(409).json({ error: "Pehle charity save karo" });
      const row = { id: "pay_" + now.toString(36) + Math.random().toString(36).slice(2, 6), kind: "settlement", amount_paise: d.dues_paise, payee_name: payee.name, payee_vpa: payee.vpa, status: "initiated", note: "ledger dues" };
      await db("jeetos_payments", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
      await audit("payment", row.id, "initiated", { amount_paise: row.amount_paise, kind: "settlement", payee: payee.vpa }, "owner");
      return res.status(200).json({ payment: row });
    }
    if (action === "pay_test_start") {
      const [payee] = await db("jeetos_payees?id=eq.charity&select=*") || [];
      if (!payee) return res.status(409).json({ error: "Pehle charity ka UPI ID save karo" });
      const pending = await db("jeetos_payments?status=eq.initiated&select=*");
      if (pending.length) return res.status(200).json({ payment: pending[0] });
      const row = { id: "pay_" + now.toString(36) + Math.random().toString(36).slice(2, 6), kind: "test", amount_paise: 100, payee_name: payee.name, payee_vpa: payee.vpa, status: "initiated", note: "₹1 test" };
      await db("jeetos_payments", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
      await audit("payment", row.id, "initiated", { amount_paise: 100, payee: payee.vpa }, "owner");
      return res.status(200).json({ payment: row });
    }
    if (action === "pay_report" || action === "pay_cancel") {
      const [p] = await db(`jeetos_payments?id=eq.${encodeURIComponent(payment_id || "")}&select=*`) || [];
      if (!p) return res.status(404).json({ error: "Payment nahi mila" });
      if (p.status !== "initiated") return res.status(409).json({ error: "Ye payment already " + p.status + " hai" });
      if (action === "pay_cancel") {
        await db(`jeetos_payments?id=eq.${encodeURIComponent(p.id)}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled", reported_at: new Date(now).toISOString() }) });
        await audit("payment", p.id, "cancelled", {}, "owner");
        return res.status(200).json({ ok: true });
      }
      const ref = String(utr || "").replace(/\s+/g, "");
      if (!/^\d{12}$/.test(ref)) return res.status(400).json({ error: "UPI Ref No / UTR 12 digit ka hota hai — payment app ki receipt mein dekho" });
      try {
        await db(`jeetos_payments?id=eq.${encodeURIComponent(p.id)}`, { method: "PATCH", body: JSON.stringify({ status: "reported_paid", utr: ref, reported_at: new Date(now).toISOString() }) });
      } catch (e) { if (/duplicate|unique|23505/.test(e.message)) return res.status(409).json({ error: "Ye UTR pehle hi kisi payment mein use ho chuka hai" }); throw e; }
      await audit("payment", p.id, "reported_paid", { utr: ref, amount_paise: p.amount_paise, verification: "self-reported (no bank/provider confirmation)" }, "owner");
      return res.status(200).json({ ok: true, status: "reported_paid" });
    }
    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
module.exports.runEngine = runEngine;
