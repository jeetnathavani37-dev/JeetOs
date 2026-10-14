// api/_auth.js — only Jeet (a user listed in jeetos_owners) may use the paid
// endpoints. The app sends his Supabase session token as "Authorization:
// Bearer <jwt>"; we ask Supabase, as that user, whether he's the owner.
const SUPABASE_URL = "https://qzripzgbstvxkfobzhyv.supabase.co";
const PUBLIC_KEY = "sb_publishable_-EA-q_dacUuWovbrCW5XVw_pPZ2vK_O";
const cache = new Map();

function bearer(req) {
  const m = /^Bearer\s+(\S+)$/.exec(String((req.headers && req.headers.authorization) || ""));
  return m && m[1].split(".").length === 3 ? m[1] : null;
}

async function isOwner(req) {
  const token = bearer(req);
  if (!token) return false;
  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) return hit.ok;
  let ok = false;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/jeetos_is_owner`, {
      method: "POST",
      headers: { apikey: PUBLIC_KEY, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: "{}",
    });
    ok = r.ok && (await r.json()) === true;
  } catch (_) { return false; }
  cache.set(token, { ok, exp: Date.now() + 5 * 60e3 });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return ok;
}

// Sends 401 and returns false unless the caller is the owner.
async function requireOwner(req, res) {
  if (await isOwner(req)) return true;
  res.status(401).json({ error: "Login required" });
  return false;
}

module.exports = { isOwner, requireOwner, bearer, SUPABASE_URL, PUBLIC_KEY };

// Does the server have a working Supabase secret (service role) key? Crons need
// it once the tables are owner-only. jeetos_owners has no policies, so only that
// key can see its row.
async function serverKeyStatus() {
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "").trim();
  if (!key) return "missing";
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/jeetos_owners?select=user_id&limit=1`, { headers: { apikey: key, Authorization: "Bearer " + key } });
    if (!r.ok) return "invalid";
    const rows = await r.json();
    return Array.isArray(rows) && rows.length ? "ok" : "invalid";
  } catch (_) { return "unreachable"; }
}
module.exports.serverKeyStatus = serverKeyStatus;
