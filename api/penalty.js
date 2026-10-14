// api/penalty.js — accountability ledger (SIMULATION: no money moves).
//   GET  (Vercel Cron, Bearer CRON_SECRET)        → run the engine
//   POST { action: "confirm_policy" }  (owner)    → activate policy v1 (server-defined rules)
//   POST { action: "stake", commitment_id, time } → stake one of his own open promises
//   POST { action: "unstake", commitment_id }     → undo within 10 min of staking
//   POST { action: "run" }             (owner)    → run the engine now
//   POST { action: "set_payee" | "pay_test_start" | "pay_report" | "pay_cancel" } → manual UPI
//        (₹1 test to the charity; he pays in his own UPI app; status is self-reported)
// The client can only read the ledger; every write happens here with the
// server key, and amounts come only from api/_penalty.js.
const { requireOwner, SUPABASE_URL } = require("./_auth");
const { POLICY_V1, plan, istDate, istAt, rupees } = require("./_penalty");

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

async function runEngine(now = Date.now()) {
  // One run at a time: a short lease row (cron retries / a manual run can't overlap).
  const until = new Date(now + 120000).toISOString();
  const lease = await db(`jeetos_engine_lock?id=eq.penalty&locked_until=lt.${encodeURIComponent(new Date(now).toISOString())}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ locked_until: until }) });
  if (!lease || !lease.length) return { skipped: "another run in progress" };
  try {
    const policy = await activePolicy();
    if (!policy) return { skipped: "no confirmed policy" };
    const from = istDate(policy.effective_from);
    const [commitments, logs, entries, incidents] = await Promise.all([
      db("jeetos_commitments?staked=eq.true&select=id,coach,text,due,status,owner,staked,agreed_at,deadline_at,done_at,resolved_at"),
      db(`jeetos_logs?day=gte.${from}&select=date,day,entries,entries_seen`),
      db("jeetos_penalty_entries?select=incident_id,kind,local_date,amount_paise&limit=10000"),
      db("jeetos_penalty_incidents?select=id,root_key,status&limit=5000"),
    ]);
    const out = plan({ policy, commitments, logs, entries, incidents, now });
    // Review / dispute outcomes are never overwritten by the engine.
    const locked = new Set(incidents.filter(i => ["disputed", "excused"].includes(i.status)).map(i => i.id));
    const incRows = out.incidents.filter(i => !locked.has(i.id)).map(i => Object.assign({}, i, { updated_at: new Date(now).toISOString() }));
    if (incRows.length) await db("jeetos_penalty_incidents?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(incRows) });
    const fresh = out.entries.filter(e => !locked.has(e.incident_id));
    let inserted = [];
    if (fresh.length) inserted = await db("jeetos_penalty_entries?on_conflict=incident_id,kind,local_date", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(fresh) }) || [];
    for (const e of inserted) await audit("penalty_entry", String(e.id), "assessed", { incident_id: e.incident_id, amount_paise: e.amount_paise, local_date: e.local_date, mode: policy.mode });
    return { policy: policy.version, mode: policy.mode, incidents: incRows.length, assessed: inserted.map(e => ({ incident: e.incident_id, date: e.local_date, amount: rupees(Number(e.amount_paise)) })) };
  } finally {
    await db("jeetos_engine_lock?id=eq.penalty", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ locked_until: "1970-01-01T00:00:00Z" }) }).catch(() => {});
  }
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
      if (!/^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.]{1,63}$/.test(v)) return res.status(400).json({ error: "UPI ID sahi format mein nahi hai (jaise name@bank)" });
      if (!n) return res.status(400).json({ error: "Charity ka naam daalo" });
      if (source_confirmed !== true) return res.status(400).json({ error: "Confirm karo ki UPI ID charity ki official site se liya hai" });
      const pending = await db("jeetos_payments?status=eq.initiated&select=id");
      if (pending.length) return res.status(409).json({ error: "Pehle chal raha payment complete ya cancel karo" });
      await db("jeetos_payees?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ id: "charity", name: n, vpa: v, source_confirmed: true, updated_at: new Date(now).toISOString() }) });
      await audit("payee", "charity", "set", { name: n, vpa: v }, "owner");
      return res.status(200).json({ ok: true });
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
