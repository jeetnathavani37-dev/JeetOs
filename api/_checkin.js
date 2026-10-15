// api/_checkin.js — the short daily check-in (pure, no I/O).
// Morning: how he slept, energy, mood, hours free today, today's one priority.
// Evening: what got done, why the rest didn't, one change for tomorrow.
// Questions he has already answered elsewhere (his log, the huddle) are
// skipped, so it's never more than 5 — usually 2-3.
const BLOCKERS = ["time", "energy", "forgot", "sick", "college/work", "mood", "other"];

const Q = {
  sleep_hours: { kind: "number", text: "Kal raat kitne ghante soye?", min: 0, max: 14, step: 0.5 },
  bedtime: { kind: "time", text: "Kitne baje soye the?" },
  energy: { kind: "scale", text: "Abhi energy kaisi hai? (1-5)" },
  mood: { kind: "scale", text: "Mood? (1-5)" },
  free_hours: { kind: "choice", text: "Aaj kitna free time hai (library ke alawa)?", options: ["<1h", "1-2h", "2-4h", "4h+"] },
  priority: { kind: "text", text: "Aaj ka ek sabse zaroori kaam?", max: 120 },
  done: { kind: "multi", text: "Aaj kya ho gaya? (tick karo)" },
  blocker: { kind: "choice", text: "Jo nahi hua, wo kyun nahi hua?", options: BLOCKERS },
  blocker_note: { kind: "text", text: "Ek line mein (optional)", max: 160, optional: true },
  tomorrow: { kind: "text", text: "Kal ek cheez kya alag karoge?", max: 160, optional: true },
};

// Which questions to ask now. ctx: { log, todayPriority, plan } for that day.
function questionsFor(kind, ctx, all) {
  ctx = ctx || {};
  const log = ctx.log || {}, out = [];
  const ask = (id, extra) => out.push(Object.assign({ id }, Q[id], extra || {}));
  if (kind === "morning") {
    if (log.sleep_hours == null) ask("sleep_hours");
    if (log.bedtime == null && log.sleep_hours == null) ask("bedtime");
    if (log.energy == null) ask("energy");
    if (log.mood == null) ask("mood");
    ask("free_hours");
    if (!(ctx.todayPriority && ctx.todayPriority.text)) ask("priority");
  } else if (kind === "evening") {
    const items = ((ctx.plan && ctx.plan.top3) || []).map(t => t.title).filter(Boolean).slice(0, 5);
    if (items.length) ask("done", { options: items });
    ask("blocker", { optional: true });
    ask("blocker_note");
    if (log.mood == null) ask("mood");
    ask("tomorrow");
  }
  return all ? out : out.slice(0, 5);
}

// Validate answers against the questions that were asked. Unknown keys and bad values are refused.
function cleanAnswers(kind, questions, answers, required) {
  const out = {}, byId = Object.fromEntries((questions || []).map(q => [q.id, q]));
  for (const k of Object.keys(answers || {})) {
    const q = byId[k], v = answers[k];
    if (!q) return { error: "unexpected answer: " + k };
    if (v == null || v === "") continue;
    if (q.kind === "number") { const n = Number(v); if (!isFinite(n) || n < q.min || n > q.max) return { error: "bad " + k }; out[k] = Math.round(n * 2) / 2; }
    else if (q.kind === "scale") { const n = Number(v); if (![1, 2, 3, 4, 5].includes(n)) return { error: "bad " + k }; out[k] = n; }
    else if (q.kind === "time") { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) return { error: "bad " + k }; out[k] = String(v); }
    else if (q.kind === "choice") { if (!q.options.includes(v)) return { error: "bad " + k }; out[k] = v; }
    else if (q.kind === "multi") { if (!Array.isArray(v) || v.some(x => !q.options.includes(x))) return { error: "bad " + k }; out[k] = [...new Set(v)]; }
    else if (q.kind === "text") { out[k] = String(v).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, q.max || 160); }
  }
  const need = required ? questions.filter(q => required.includes(q.id)) : questions;
  for (const q of need) if (!q.optional && q.kind !== "multi" && out[q.id] == null) return { error: "missing " + q.id };
  if (kind === "evening" && byId.done) out.not_done = byId.done.options.filter(o => !(out.done || []).includes(o));
  return { answers: out };
}

// Fill gaps in his log from the morning check-in (never overwrite what he logged).
function overlayLog(log, morning) {
  if (!morning || !morning.answers) return log;
  const a = morning.answers, l = Object.assign({}, log || { day: morning.day });
  if (l.sleep_hours == null && a.sleep_hours != null) { l.sleep_hours = a.sleep_hours; l.sleep_from = "checkin"; }
  if (l.bedtime == null && a.bedtime) l.bedtime = a.bedtime;
  if (l.energy == null && a.energy != null) l.energy = a.energy;
  if (l.mood == null && a.mood != null) l.mood = a.mood;
  return l;
}

// When each check-in is offered (IST hour of the plan day).
function due(kind, istHour) {
  if (kind === "morning") return istHour >= 5 && istHour < 14;
  return istHour >= 20 || istHour < 3;
}

module.exports = { questionsFor, cleanAnswers, overlayLog, due, BLOCKERS, Q };
