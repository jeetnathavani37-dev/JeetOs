// api/_huddle.js — the Head Coach's morning huddle, on the server.
// Claude reads the head-scope team context and pending coach proposals and
// suggests today's focus, the one priority, conflicts between coaches, and
// short notes to specialists. The CODE then:
//   - keeps the priority only if it matches today's computed plan (or his own
//     morning priority) — Claude can't invent a new task
//   - resolves every conflict with a fixed ladder, citing the rule:
//       safety > primary goal > sleep ≥ 6h > hard commitments > preferences
//     a tie is not decided by the AI — it goes to Jeet
//   - stores one huddle per day (re-runs are no-ops)
const COACHES = ["skin", "hair", "fitness", "nutrition", "sleep", "style", "grooming", "ronaldo", "mind"];
const LADDER = ["safety", "primary_goal", "sleep", "commitment", "preference"];
const RULE = {
  safety: "safety and health come first",
  primary_goal: "the primary goal comes before department wishes",
  sleep: "6h+ sleep is protected over extras",
  commitment: "a promise he already made beats a new preference",
  preference: "preference",
};

function huddlePrompt(packet, pending, plan) {
  const top = ((plan && plan.top3) || []).map((t, i) => `${i + 1}. ${t.title}`).join("\n") || "(no plan items)";
  const props = (pending || []).map(d => `- ${d.coach}: "${d.change}"${d.reason ? ` (why: ${d.reason})` : ""}`).join("\n") || "- none";
  return {
    system: `You are the HEAD COACH chairing Jeet's private morning huddle (coaches: ${COACHES.join(", ")}). Use ONLY the facts below — never invent numbers. Missing data is unknown, not failure.

${packet}

TODAY'S COMPUTED PLAN (pick the priority from here, or from his own morning priority):
${top}

PENDING COACH PROPOSALS (not approved yet):
${props}

Find CONFLICTS: two coaches pushing him in opposite directions (e.g. more calories vs deficit, late gym vs early bed). For each side give a category from: ${LADDER.join(", ")}.
Reply with ONLY JSON:
{"focus":"one plain line: the team's #1 focus today and why","priority":"exactly one item from today's plan","conflicts":[{"between":["a","b"],"a_wants":"...","b_wants":"...","a_category":"...","b_category":"...","issue":"..."}],"notes":[{"to":"coach id or team","text":"one actionable line"}]}
At most 3 conflicts and 5 notes. Plain words, Jeet can read them.`,
    user: "Run today's huddle.",
  };
}

function parseJson(text) {
  const t = String(text || "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { return null; }
}
const clip = (s, n) => String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, n);

// Deterministic resolution of each conflict.
function resolve(conflicts) {
  return (Array.isArray(conflicts) ? conflicts : []).slice(0, 3).map(c => {
    const between = (Array.isArray(c.between) ? c.between : []).filter(x => COACHES.includes(x)).slice(0, 2);
    if (between.length !== 2) return null;
    const ca = LADDER.indexOf(c.a_category), cb = LADDER.indexOf(c.b_category);
    const base = { between, issue: clip(c.issue, 240), a_wants: clip(c.a_wants, 160), b_wants: clip(c.b_wants, 160) };
    if (ca < 0 || cb < 0 || ca === cb) return Object.assign(base, { winner: null, needs_jeet: true, rule: "same priority level — Jeet decides", resolution: "Keep the current plan for now; ask Jeet which matters more." });
    const aWins = ca < cb, win = aWins ? between[0] : between[1], cat = LADDER[Math.min(ca, cb)];
    return Object.assign(base, { winner: win, needs_jeet: false, rule: RULE[cat], resolution: `${win}'s side wins: ${aWins ? base.a_wants : base.b_wants} (${RULE[cat]}).` });
  }).filter(Boolean);
}

// Claude's output → today's stored huddle.
function finalize(parsed, ctx) {
  const plan = (ctx.plan && ctx.plan.top3) || [], titles = plan.map(t => t.title);
  const own = ctx.morningPriority || null;
  let priority = parsed && clip(parsed.priority, 160);
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const match = titles.find(t => norm(t) === norm(priority)) || (own && norm(own) === norm(priority) ? own : null);
  priority = match || own || titles[0] || null;               // never a task the plan doesn't have
  const notes = (parsed && Array.isArray(parsed.notes) ? parsed.notes : []).slice(0, 5)
    .map(n => ({ to: COACHES.includes(n && n.to) || (n && n.to) === "team" ? n.to : null, text: clip(n && n.text, 220) })).filter(n => n.to && n.text.length > 3);
  return {
    day: ctx.day,
    focus: clip(parsed && parsed.focus, 300) || (priority ? `Today: ${priority}` : null),
    priority,
    conflicts: resolve(parsed && parsed.conflicts),
    notes: { list: notes, priority_from: match ? "huddle" : own ? "his morning check-in" : titles.length ? "plan" : null },
  };
}

// Full run with an injected Claude caller (system, user) → text.
async function runHuddle({ packet, pending, plan, day, morningPriority, callClaude }) {
  const p = huddlePrompt(packet, pending, plan);
  let parsed = null;
  try { parsed = parseJson(await callClaude(p.system, p.user)); } catch (_) { parsed = null; }
  const rec = finalize(parsed || {}, { plan, day, morningPriority });
  rec.notes.ai = !!parsed;
  return rec;
}

// Today's huddle, created once. q(path) → rows|null; write(path, body) → { ok }.
async function ensureHuddle({ q, write, callClaude, now, source }) {
  const { loadContextData, buildPacket, planDay } = require("./_context");
  now = now || Date.now();
  const day = planDay(now);
  const have = await q(`jeetos_huddles?day=eq.${day}&select=*`);
  if (Array.isArray(have) && have.length) return { huddle: have[0], created: false };
  const [raw, pending] = await Promise.all([loadContextData(q, now), q("jeetos_decisions?status=eq.pending&select=coach,change,reason&order=created_at.desc&limit=8")]);
  const pk = buildPacket(raw, { coach: "head", purpose: "huddle", now });
  const m = (raw.dailyCheckins || []).find(c => String(c.day).slice(0, 10) === day && c.kind === "morning");
  const rec = await runHuddle({ packet: pk.text, pending: pending || [], plan: pk.plan, day, morningPriority: m && m.answers && m.answers.priority, callClaude });
  const row = Object.assign({}, rec, { source: source || "server", created_at: new Date(now).toISOString() });
  const w = await write("jeetos_huddles?on_conflict=day", row, { Prefer: "resolution=ignore-duplicates,return=representation" });
  if (!w.ok) return { huddle: row, created: false, error: "couldn't save (" + w.status + ")" };
  if (!(Array.isArray(w.body) && w.body.length)) return { huddle: ((await q(`jeetos_huddles?day=eq.${day}&select=*`)) || [])[0] || row, created: false };
  const notes = rec.notes.list.map((n, i) => ({ id: `h${day.replace(/-/g, "")}${i}`, from_coach: "head", to_coach: n.to, text: n.text, source: "huddle", created_at: new Date(now).toISOString() }));
  if (notes.length) await write("jeetos_coach_notes?on_conflict=id", notes, { Prefer: "resolution=ignore-duplicates,return=minimal" });
  return { huddle: row, created: true };
}

module.exports = { huddlePrompt, parseJson, resolve, finalize, runHuddle, ensureHuddle, LADDER };
