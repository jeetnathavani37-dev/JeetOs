// api/_vault.js — his knowledge vault: notes, plans and pasted docs he saves,
// searchable with Postgres full-text search (jeetos_search_docs). Coaches get
// the few best matches for what he just asked, with title + date to cite, and
// are told to say "not in your vault" instead of guessing. Private docs are
// only searchable by him in the app — never sent to a coach. Encrypted vault
// photos are never server-searchable.
const STOP = new Set("the and for are but not you your with this that have has had was were what when where which who why how can could should would will just like from into about them they then than there their our out off very also some any all too its it's i'm me my mujhe mera meri mere hai hain tha thi the kya kaise kyu kyun kab kaha kahan aur bhi nahi nhi toh to ko ki ka ke se mein me main hum tum aap yeh ye woh wo kar karo karna kiya hona hoga raha rahi rahe ek do bas abhi kuch sab bhai yaar please plz ok okay haan han wala wali wale kitna kitni kitne".split(" "));

const clip = (s, n) => String(s == null ? "" : s).replace(/<[^>]*>/g, "").replace(/[ \t]+/g, " ").trim().slice(0, n);

// Validate a new/edited doc. Returns { row } or { error }.
function cleanDoc(input, existing) {
  const i = input || {}, e = existing || {};
  const title = i.title != null ? clip(i.title, 160).replace(/\s+/g, " ") : e.title;
  const body = i.body != null ? String(i.body).replace(/<[^>]*>/g, "").replace(/\r/g, "").trim() : (e.body || "");
  if (!title) return { error: "title required" };
  if (body.length > 20000) return { error: "too long (max 20,000 characters) — split it into parts" };
  const tags = i.tags != null ? [...new Set((Array.isArray(i.tags) ? i.tags : String(i.tags).split(/[,#\s]+/)).map(t => String(t).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24)).filter(Boolean))].slice(0, 8) : (e.tags || []);
  const url = i.url != null ? (/^https?:\/\/[^\s<>"]{3,500}$/.test(String(i.url).trim()) ? String(i.url).trim() : null) : (e.url || null);
  if (i.url && !url) return { error: "link must start with http(s)://" };
  const scope = i.scope != null ? (i.scope === "private" ? "private" : "team") : (e.scope || "team");
  const source = url ? "link" : body.length > 1500 ? "pasted" : "note";
  return { row: { title, body, tags, url, scope, source } };
}

// Keywords from his chat message → an OR query (websearch syntax). null if nothing searchable.
function queryFrom(message) {
  const words = String(message || "").toLowerCase().replace(/https?:\/\/\S+/g, " ").match(/[a-z0-9][a-z0-9-]{2,}/g) || [];
  const seen = [], out = [];
  for (const w of words) if (!STOP.has(w) && !/^\d+$/.test(w) && !seen.includes(w)) { seen.push(w); out.push(w); }
  return out.length ? out.slice(0, 8).join(" or ") : null;
}

// Packet lines with citations. hits: rows from jeetos_search_docs.
function vaultLines(hits) {
  return (hits || []).filter(h => h.scope !== "private").slice(0, 3).map(h => `[${clip(h.title, 80)}, ${String(h.updated_at || h.created_at).slice(0, 10)}] ${clip(String(h.snippet || "").replace(/\n+/g, " "), 320)}`);
}
const VAULT_TITLE = "FROM HIS KNOWLEDGE VAULT (his own saved notes — cite as [title, date]; if the answer isn't here or in the data above, say you don't have it instead of guessing)";

// rpc(name, body) → rows|null. Never throws; no query → [].
async function searchVault(rpc, q, opts) {
  opts = opts || {};
  if (!q) return [];
  try { const rows = await rpc("jeetos_search_docs", { q, include_private: !!opts.includePrivate, lim: opts.limit || 5 }); return Array.isArray(rows) ? rows : null; }
  catch (_) { return null; }
}

module.exports = { cleanDoc, queryFrom, vaultLines, searchVault, VAULT_TITLE };
