// api/push.js — iPhone / web push subscriptions for JeetOS.
//   GET                         → { publicKey } for pushManager.subscribe
//   POST { action: "subscribe", subscription }
//   POST { action: "unsubscribe", endpoint }
//   POST { action: "test" }     → sends a test notification to every device
const { vapidKeys, sendToAll } = require("./_push");

const SUPABASE_URL = "https://qzripzgbstvxkfobzhyv.supabase.co";
const PUBLIC_KEY = "sb_publishable_-EA-q_dacUuWovbrCW5XVw_pPZ2vK_O";
const SUPABASE_KEYS = [...new Set([process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.SUPABASE_ANON_KEY, PUBLIC_KEY].filter(Boolean).map(k => k.trim()))];
async function supa(path, init = {}) {
  let r;
  for (const key of SUPABASE_KEYS) {
    r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, Object.assign({}, init, {
      headers: Object.assign({ apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }, init.headers || {}),
    }));
    if (r.status !== 401) return r;
  }
  return r;
}

module.exports = async function handler(req, res) {
  const k = vapidKeys();
  if (req.method === "GET") return res.status(200).json({ publicKey: k ? k.publicKey : null, enabled: !!k });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!k) return res.status(501).json({ error: "Push not configured (no VAPID seed)" });
  const { action, subscription, endpoint } = req.body || {};
  if (action === "subscribe") {
    const s = subscription || {};
    if (!s.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) return res.status(400).json({ error: "bad subscription" });
    const r = await supa("jeetos_push_subs?on_conflict=endpoint", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, ua: String(req.headers["user-agent"] || "").slice(0, 200) }) });
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok });
  }
  if (action === "unsubscribe") {
    if (!endpoint) return res.status(400).json({ error: "endpoint required" });
    await supa(`jeetos_push_subs?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: "DELETE" });
    return res.status(200).json({ ok: true });
  }
  if (action === "test") {
    const out = await sendToAll(supa, { title: "JeetOS 🔔", body: "Push notifications chal rahe hain ✅ Coaches ab yahin message karenge.", url: "/", tag: "test" });
    return res.status(200).json(out);
  }
  return res.status(400).json({ error: "unknown action" });
};
