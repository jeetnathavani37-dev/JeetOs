// api/_timeline.js — the evolution timeline (pure, read-only).
// One list of how his system changed over time, built only from stored
// records: goal plan changes, decisions and their outcomes, facts that were
// replaced or removed, experiments and their verdicts, weekly reviews, weight
// goals, and schedule changes. Nothing is inferred; every entry points to its record.
const day10 = d => String(d || "").slice(0, 10);
const clip = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n || 160);
const KINDS = ["goal", "decision", "memory", "experiment", "review", "weight", "schedule"];

function buildTimeline(src, opts) {
  src = src || {}; opts = opts || {};
  const out = [], push = (at, kind, title, detail, ref) => { if (at && Date.parse(at)) out.push({ at: new Date(Date.parse(at)).toISOString(), day: day10(new Date(Date.parse(at) + 330 * 60000).toISOString()), kind, title: clip(title, 200), detail: detail ? clip(detail, 300) : null, ref }); };
  const goalTitle = Object.fromEntries((src.goals || []).map(g => [g.id, g.title]));
  (src.goalEvents || []).forEach(e => {
    const t = goalTitle[e.goal_id] || e.goal_id, d = e.detail || {};
    if (e.action === "approve") push(e.at, "goal", `Goal plan approved: ${t}`, null, { table: "goal_events", id: e.id });
    else if (e.action === "target") push(e.at, "goal", `${t}: target changed`, d.from && d.to ? Object.keys(d.to).filter(k => d.from[k] !== d.to[k]).map(k => `${k} ${d.from[k]} → ${d.to[k]}`).join(", ") || null : null, { table: "goal_events", id: e.id });
    else if (e.action === "cancel" || e.action === "resume") push(e.at, "goal", `${t}: ${e.action === "cancel" ? "paused" : "resumed"}`, d.reason || null, { table: "goal_events", id: e.id });
  });
  (src.decisions || []).forEach(x => {
    if (x.status === "approved" && x.decided_at) push(x.decided_at, "decision", `Decided: ${x.change}`, [x.coach && x.coach !== "jeet" ? `from ${x.coach}` : null, x.expected_outcome ? `expected: ${x.expected_outcome}` : null].filter(Boolean).join(" · ") || null, { table: "decisions", id: x.id });
    if (x.verdict && x.outcome_at) push(x.outcome_at, "decision", `Reviewed: ${x.change} — ${x.verdict === "worked" ? "worked" : x.verdict === "didnt" ? "didn't work" : "unclear"}`, x.actual_outcome || null, { table: "decisions", id: x.id });
  });
  const memText = Object.fromEntries((src.memories || []).map(m => [m.id, m.text]));
  (src.memoryEvents || []).forEach(e => {
    const d = e.detail || {}, old = memText[e.memory_id];
    if (e.action === "supersede") push(e.at, "memory", old ? `Changed: "${clip(old, 80)}" → "${clip(d.new_text, 80)}"` : `A fact was updated → "${clip(d.new_text, 80)}"`, null, { table: "memory_events", id: e.id });
    else if (e.action === "retract") push(e.at, "memory", old ? `Removed: "${clip(old, 100)}"` : "A fact was removed", d.reason || null, { table: "memory_events", id: e.id });
  });
  (src.experiments || []).forEach(x => {
    if (x.kind === "measured") {
      push(x.created_at, "experiment", `Experiment started: ${x.action}`, `${x.target}: before ${x.baseline}; worked = ${x.criterion}`, { table: "experiments", id: x.id });
      if (x.decided_at) push(x.decided_at, "experiment", `Experiment ${x.status === "worked" ? "worked" : x.status === "failed" ? "didn't work" : x.status === "stopped" ? "stopped" : "unclear"}: ${x.action}`, x.outcome, { table: "experiments", id: x.id });
    } else if (["worked", "failed", "mixed"].includes(x.status)) push(x.updated_at || x.created_at, "experiment", `Coach experiment ${x.status}: ${x.action}`, x.outcome, { table: "experiments", id: x.id });
  });
  (src.reviews || []).forEach(r => {
    const d = r.data || {}, a = d.anchors || {}, e = d.evening || {}, w = d.weight || {};
    const bits = [a.scheduled ? `anchors on time ${a.pct_on_time}%` : null, e.planned ? `plan done ${e.pct_done}%` : null, w.change_kg != null ? `weight ${w.change_kg > 0 ? "+" : ""}${w.change_kg} kg` : null].filter(Boolean);
    push(day10(r.week_end) + "T18:00:00+05:30", "review", `Week ${day10(r.week_start)} → ${day10(r.week_end)}`, bits.join(" · ") || "little data that week", { table: "weekly_reviews", id: day10(r.week_end) });
  });
  (src.weightGoals || []).forEach(g => {
    push(g.requested_at, "weight", `Weight goal set: −${g.target_loss_kg} kg in ${g.weeks} weeks`, g.baseline_kg ? `baseline ${g.baseline_kg} kg (${day10(g.baseline_day)})` : "baseline pending (3 fasted weigh-ins)", { table: "weight_goals", id: g.id });
    if (["achieved", "missed", "cancelled"].includes(g.status) && g.updated_at) push(g.updated_at, "weight", `Weight goal ${g.status}`, null, { table: "weight_goals", id: g.id });
  });
  ((src.schedule && src.schedule.overrides) || []).forEach(o => push(o.approved_at, "schedule", o.revert ? `${o.anchor}: back to ${o.time} from ${o.from}` : `${o.anchor}: ${o.was || "?"} → ${o.time} from ${o.from}`, o.evidence ? `late ${o.evidence.late_days} of ${o.evidence.of_days} days` : null, { table: "settings", id: "schedule" }));

  let list = out.sort((a, b) => b.at.localeCompare(a.at));
  if (Array.isArray(opts.kinds) && opts.kinds.length) list = list.filter(x => opts.kinds.includes(x.kind));
  if (opts.before) list = list.filter(x => x.at < opts.before);
  return list.slice(0, opts.limit || 60);
}

module.exports = { buildTimeline, KINDS };
