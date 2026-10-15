// api/os.js — JeetOS "operating system" actions (one function, action-routed,
// to stay under the Vercel Hobby function limit). Owner only.
//
//   GET  /api/os?action=memories            live memories + recently closed ones
//   GET  /api/os?action=memories&id=<id>    one memory's history
//   POST /api/os { action: "memory.propose", coach, source, items: [...] }
//   POST /api/os { action: "memory.act", id, op: confirm|retract|keep|edit|share, text? }
//
// Rules live in api/_memory.js; this file only reads, applies and audits.
const { requireOwner, bearer, SUPABASE_URL, PUBLIC_KEY } = require("./_auth");
const { planPropose, planAct, classify } = require("./_memory");

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
    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 200) });
  }
};
