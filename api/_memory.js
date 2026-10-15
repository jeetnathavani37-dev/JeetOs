// api/_memory.js — Memory v2 rules (pure, no I/O).
// Claude proposes; these rules decide what becomes a memory and how.
//  - Things Jeet said (via a coach's note or the memory pass) → active, medium confidence.
//  - A coach's guess ("lagta hai", "probably", "seems") → unconfirmed, low, until Jeet confirms.
//  - Jeet adding/confirming/editing in the app → active, high.
//  - New info that changes an old fact supersedes it (history kept, nothing deleted).
//  - A coach suggesting a fact is no longer true only flags it; Jeet decides.
//  - Mind-coach memories stay private to the mind coach unless Jeet shares them.
//  - Every fact has a review date; after it, it's shown as "may be outdated".

const KINDS = ["fact", "preference", "constraint", "goal_context", "struggle", "win", "life", "lesson", "style"];
const SECTION_KIND = { about: "fact", goals: "goal_context", routine: "constraint", preferences: "preference", struggles: "struggle", wins: "win", style: "style", life: "life" };
const KIND_LABEL = { fact: "about", goal_context: "goals", constraint: "routine", preference: "preferences", struggle: "struggles", win: "wins", style: "style", life: "life", lesson: "lessons" };
const REVIEW_DAYS = { fact: 180, preference: 120, constraint: 60, goal_context: 45, struggle: 60, win: 365, life: 180, lesson: 365, style: 180 };
const COACH_RE = /^[a-z]{2,12}$/;

// Never stored: secrets, money/account numbers, crisis details.
const SENSITIVE = /(password|passcode|api[ _-]?key|\bsk-[a-z0-9-]{6,}|\botp\b|\bpin\b|\bcvv\b|account (no|number)|\b\d{9,18}\b|suicid|self[- ]?harm|kill (myself|himself)|khudkushi)/i;
// A coach's guess rather than something Jeet said.
const INFERENCE = /\b(seems?|probably|likely|maybe|might|apparently|i think|guess|lagta hai|shayad|ho sakta)\b/i;

const norm = t => String(t || "").toLowerCase().replace(/<[^>]*>/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
const clean = t => String(t || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
const addDays = (iso, n) => new Date(Date.parse(String(iso).slice(0, 10) + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const newId = () => "m" + (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^a-z0-9]/gi, "").slice(0, 32);

// One proposed item → a memory row (or null if it must not be stored).
// source: "tag" (a coach's <memory> note) | "memory_pass" | "user" (Jeet in the app)
function classify(item, opts) {
  const now = opts.now || new Date().toISOString();
  const text = clean(item.text);
  if (text.length < 4 || SENSITIVE.test(text)) return null;
  const kind = KINDS.includes(item.kind) ? item.kind : SECTION_KIND[item.section] || "fact";
  const coach = COACH_RE.test(opts.coach || "") ? opts.coach : null;
  const byJeet = opts.source === "user";
  const guess = !byJeet && INFERENCE.test(text);
  return {
    id: newId(), kind, text, norm: norm(text),
    scope: coach === "mind" && !byJeet ? "private:mind" : "team",
    source_type: byJeet ? "jeet_confirmed" : guess ? "coach_inferred" : "jeet_said",
    source_ref: String(opts.source_ref || opts.source || "").slice(0, 120) || null,
    coach, confidence: byJeet ? "high" : guess ? "low" : "med",
    status: guess ? "unconfirmed" : "active",
    observed_at: now, review_after: addDays(now, REVIEW_DAYS[kind]),
  };
}

// Proposals from a chat turn → { inserts, updates, events }. `live` = current active/unconfirmed rows.
// item: { text, kind?|section?, replaces?: old text, remove?: true, reason? }
function planPropose(live, items, opts) {
  const now = opts.now || new Date().toISOString();
  const actor = opts.source === "user" ? "jeet" : "coach:" + (COACH_RE.test(opts.coach || "") ? opts.coach : "team");
  const byNorm = new Map((live || []).map(m => [m.norm || norm(m.text), m]));
  const out = { inserts: [], updates: [], events: [] };
  for (const it of (items || []).slice(0, 8)) {
    if (!it || typeof it !== "object") continue;
    if (it.remove) {                               // "no longer true" → flag for Jeet, never auto-delete
      const old = byNorm.get(norm(it.text));
      if (!old || old.pending) continue;
      out.updates.push({ id: old.id, patch: { pending: "retract", pending_reason: clean(it.reason || "coach thinks this is no longer true").slice(0, 200), updated_at: now } });
      out.events.push({ memory_id: old.id, action: "retract_proposed", actor, detail: { reason: it.reason || null } });
      old.pending = "retract";
      continue;
    }
    const row = classify(it, Object.assign({}, opts, { now }));
    if (!row || byNorm.has(row.norm)) continue;      // dropped or already known
    const old = it.replaces ? byNorm.get(norm(it.replaces)) : null;
    if (old) {
      row.supersedes = old.id;
      if (old.scope && old.scope !== "team" && row.scope === "team") row.scope = old.scope;   // a private fact stays private
      out.updates.push({ id: old.id, patch: { status: "superseded", superseded_by: row.id, pending: null, updated_at: now }, after: row.id });
      out.events.push({ memory_id: old.id, action: "supersede", actor, detail: { by: row.id, new_text: row.text } });
      byNorm.delete(old.norm || norm(old.text));
    }
    out.inserts.push(row);
    out.events.push({ memory_id: row.id, action: "create", actor, detail: { source_type: row.source_type, confidence: row.confidence, supersedes: row.supersedes || null } });
    byNorm.set(row.norm, row);
  }
  return out;
}

// Jeet's own actions on one memory. op: confirm | retract | keep (reject a proposed retraction) | edit | share
function planAct(mem, op, opts) {
  opts = opts || {};
  const now = opts.now || new Date().toISOString();
  const out = { inserts: [], updates: [], events: [] };
  if (!mem || mem.status === "superseded" || mem.status === "retracted") return Object.assign(out, { error: "memory is not live" });
  if (op === "confirm") {
    out.updates.push({ id: mem.id, patch: { status: "active", source_type: "jeet_confirmed", confidence: "high", pending: null, pending_reason: null, review_after: addDays(now, REVIEW_DAYS[mem.kind] || 120), updated_at: now } });
    out.events.push({ memory_id: mem.id, action: "confirm", actor: "jeet", detail: {} });
  } else if (op === "retract") {
    out.updates.push({ id: mem.id, patch: { status: "retracted", pending: null, updated_at: now } });
    out.events.push({ memory_id: mem.id, action: "retract", actor: "jeet", detail: { reason: opts.reason || null } });
  } else if (op === "keep") {
    if (!mem.pending) return Object.assign(out, { error: "nothing pending" });
    out.updates.push({ id: mem.id, patch: { pending: null, pending_reason: null, updated_at: now } });
    out.events.push({ memory_id: mem.id, action: "retract_rejected", actor: "jeet", detail: {} });
  } else if (op === "share") {
    if (mem.scope === "team") return Object.assign(out, { error: "already shared" });
    out.updates.push({ id: mem.id, patch: { scope: "team", updated_at: now } });
    out.events.push({ memory_id: mem.id, action: "share", actor: "jeet", detail: { from: mem.scope } });
  } else if (op === "edit") {
    const row = classify({ text: opts.text, kind: mem.kind }, { now, source: "user", coach: mem.coach, source_ref: "edited in app" });
    if (!row) return Object.assign(out, { error: "text not allowed" });
    if (row.norm === (mem.norm || norm(mem.text))) return Object.assign(out, { error: "no change" });
    row.scope = mem.scope; row.supersedes = mem.id;
    out.inserts.push(row);
    out.updates.push({ id: mem.id, patch: { status: "superseded", superseded_by: row.id, pending: null, updated_at: now }, after: row.id });
    out.events.push({ memory_id: row.id, action: "edit", actor: "jeet", detail: { supersedes: mem.id } }, { memory_id: mem.id, action: "supersede", actor: "jeet", detail: { by: row.id, new_text: row.text } });
  } else return Object.assign(out, { error: "unknown op" });
  return out;
}

// What a coach may see: team facts, facts private to that coach, and nothing superseded/retracted.
function visibleTo(mem, coach) {
  if (mem.status !== "active" && mem.status !== "unconfirmed") return false;
  if (mem.scope === "team") return true;
  if (mem.scope === "private:mind") return coach === "mind";
  return mem.scope === "coach:" + coach;
}
// Short provenance label for prompts and the app.
function label(mem, today) {
  const bits = [];
  if (mem.status === "unconfirmed") bits.push("UNCONFIRMED guess — ask before relying on it");
  if (mem.review_after && String(mem.review_after).slice(0, 10) < today) bits.push("may be outdated");
  if (mem.pending === "retract") bits.push("possibly no longer true");
  bits.push({ jeet_confirmed: "Jeet confirmed", jeet_said: "Jeet said", coach_inferred: "coach's inference", migrated: "older note", log: "from his log", system: "system" }[mem.source_type] || mem.source_type);
  return bits.join("; ");
}

module.exports = { classify, planPropose, planAct, visibleTo, label, norm, KINDS, SECTION_KIND, KIND_LABEL, REVIEW_DAYS, SENSITIVE };
