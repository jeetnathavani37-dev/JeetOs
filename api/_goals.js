// api/_goals.js — the goal graph (pure, no I/O).
// One primary goal (the 10 kg plan) with supporting goals owned by the
// department coaches. Health is computed from his real data, the same way
// every time:
//   on_track / behind / at_risk / unknown (not enough data — never "failed")
// A supporting goal at risk only FLAGS the primary ("plan may need
// adjustment"); nothing here ever changes a target or a timeline.
const { addDays, bedMinutes, weightTrend, WEIGHT_RULES } = require("./_penalty");

// The proposal Jeet approves (nothing exists until he does).
const PLAN = [
  { id: "weight10", kind: "primary", title: "Lose 10 kg in 12 weeks, at a healthy pace", owner_coach: "head", metric: "weight", target: { loss_kg: 10, weeks: 12 },
    why: "The whole team's first priority; every department plan supports it." },
  { id: "diet", kind: "supporting", parent_id: "weight10", title: "Calories ≤ 2,100 and no junk on most days", owner_coach: "nutrition", metric: "diet_kcal", target: { kcal: 2100, rate: 0.85 },
    why: "A steady deficit drives the weight loss." },
  { id: "gym", kind: "supporting", parent_id: "weight10", title: "Gym 5+ days a week (Mon–Sat)", owner_coach: "fitness", metric: "gym_days", target: { per_week: 5 },
    why: "Training keeps muscle while the weight comes off." },
  { id: "sleep", kind: "supporting", parent_id: "weight10", title: "Asleep by 12:30 AM with 6h+ sleep", owner_coach: "sleep", metric: "sleep_window", target: { bed: "00:30", hours: 6, rate: 0.85 },
    why: "Short or late sleep raises hunger and kills gym energy." },
  { id: "weighin", kind: "supporting", parent_id: "weight10", title: "A fasted morning weigh-in every week", owner_coach: "ronaldo", metric: "weighin_weekly", target: { per_days: 7 },
    why: "Without weigh-ins nobody can tell if the plan works." },
];

const STATES = ["on_track", "behind", "at_risk", "unknown"];
const day10 = d => String(d || "").slice(0, 10);
// The last 7 finished days (today is still in progress, so it only counts if already done).
const windowDays = today => Array.from({ length: 7 }, (_, i) => addDays(today, -7 + i));
const recoveryDays = raw => new Set((raw.marks || []).filter(m => m.kind === "recovery").map(m => day10(m.date)));
const logOn = (raw, d) => (raw.logs || []).find(l => day10(l.day) === d) || null;
const rate3 = (x, good, ok) => (x >= good ? "on_track" : x >= ok ? "behind" : "at_risk");

function dietHealth(g, raw, today) {
  const lim = (g.target && g.target.kcal) || 2100, need = (g.target && g.target.rate) || 0.85, rec = recoveryDays(raw);
  const days = windowDays(today).filter(d => !rec.has(d)).map(d => logOn(raw, d)).filter(l => l && l.total_cal != null);
  if (days.length < 4) return { state: "unknown", n: days.length, detail: `only ${days.length} of the last 7 days have calories logged` };
  const okDays = days.filter(l => +l.total_cal <= lim && !(+l.junk_meals > 0)).length;
  const r = okDays / days.length;
  return { state: rate3(r, need, 0.6), n: days.length, value: Math.round(r * 100), detail: `${okDays}/${days.length} logged days within ${lim} kcal and no junk` };
}

function gymHealth(g, raw, today) {
  const want = (g.target && g.target.per_week) || 5, rec = recoveryDays(raw);
  const win = windowDays(today), dow = d => new Date(d + "T12:00:00Z").getUTCDay();
  const sched = win.filter(d => dow(d) !== 0 && !rec.has(d));
  const done = d => (raw.checkins || []).some(c => c.anchor === "gym" && day10(c.day) === d) || !!(logOn(raw, d) && logOn(raw, d).gym_done);
  const any = win.some(d => logOn(raw, d)) || (raw.checkins || []).some(c => win.includes(day10(c.day)));
  if (!any) return { state: "unknown", n: 0, detail: "no gym check-ins or logs in the last 7 days" };
  const n = sched.filter(done).length + (done(today) ? 1 : 0), expected = Math.min(want, sched.length);
  return { state: n >= expected ? "on_track" : n >= expected - 2 ? "behind" : "at_risk", n, value: n, detail: `${n} gym day${n === 1 ? "" : "s"} in the last 7 (target ${expected}${rec.size ? ", recovery days excused" : ""})` };
}

function sleepHealth(g, raw, today) {
  const t = g.target || {}, need = t.rate || 0.85, minH = t.hours || 6, rec = recoveryDays(raw);
  const late = bedMinutes(t.bed || "00:30");
  const days = windowDays(today).concat([today]).filter(d => !rec.has(d)).map(d => logOn(raw, d)).filter(l => l && l.sleep_hours != null);
  if (days.length < 4) return { state: "unknown", n: days.length, detail: `only ${days.length} nights of sleep logged this week` };
  const good = days.filter(l => {
    const b = l.bedtime ? bedMinutes(l.bedtime) : null;
    const onTime = b == null || b <= late || b >= 18 * 60;
    return +l.sleep_hours >= minH && onTime;
  }).length;
  const r = good / days.length;
  return { state: rate3(r, need, 0.6), n: days.length, value: Math.round(r * 100), detail: `${good}/${days.length} nights ≥${minH}h and in bed by ${t.bed || "00:30"}` };
}

function weighinHealth(g, raw, today) {
  const q = (raw.weighins || []).filter(w => w.fasted && w.morning).map(w => day10(w.day)).sort();
  const last = q[q.length - 1];
  if (!last) return { state: "unknown", n: 0, detail: "no fasted morning weigh-in yet" };
  const gap = Math.round((Date.parse(today) - Date.parse(last)) / 864e5);
  return { state: gap <= 7 ? "on_track" : gap <= 13 ? "behind" : "at_risk", n: q.length, value: gap, detail: `last fasted weigh-in ${gap === 0 ? "today" : gap + " day(s) ago"}` };
}

function weightHealth(g, raw, today) {
  const wg = raw.weightGoal;
  if (!wg) return { state: "unknown", n: 0, detail: "the 10 kg plan isn't started in the Ledger yet (it needs 3 fasted morning weigh-ins for a baseline)" };
  if (wg.baseline_kg == null) return { state: "unknown", n: 0, detail: "baseline not set yet — needs 3 fasted morning weigh-ins" };
  const tr = weightTrend(raw.weighins || [], today, WEIGHT_RULES);
  if (tr.cur == null) return { state: "unknown", n: 0, detail: "no fasted weigh-ins in the last 7 days" };
  const start = wg.start_day || wg.baseline_day, span = Date.parse(wg.end_day) - Date.parse(start), el = Date.parse(today) - Date.parse(start);
  const expected = span > 0 && el > 0 ? +wg.target_loss_kg * Math.min(1, el / span) : 0;
  const lost = Math.round((+wg.baseline_kg - tr.cur) * 10) / 10;
  const detail = `lost ${lost} kg of ${+wg.target_loss_kg} (plan expects ~${Math.round(expected * 10) / 10} by now)`;
  if (tr.fast) return { state: "at_risk", n: 1, value: lost, detail: detail + `; losing ${tr.pct_week}%/week — faster than safe (>1%)` };
  if (expected < 0.5) return { state: lost >= 0 ? "on_track" : "behind", n: 1, value: lost, detail };
  return { state: lost >= 0.8 * expected ? "on_track" : lost >= 0.4 * expected ? "behind" : "at_risk", n: 1, value: lost, detail };
}

const HEALTH = { weight: weightHealth, diet_kcal: dietHealth, gym_days: gymHealth, sleep_window: sleepHealth, weighin_weekly: weighinHealth };

// Health for every active goal, plus the primary's roll-up flags.
function graphHealth(goals, raw, today) {
  const active = (goals || []).filter(g => g.status === "active");
  const out = active.map(g => Object.assign({ id: g.id, kind: g.kind, title: g.title, owner_coach: g.owner_coach, parent_id: g.parent_id || null }, (HEALTH[g.metric] || (() => ({ state: "unknown", detail: "unknown metric" })))(g, raw, today)));
  const primary = out.find(g => g.kind === "primary") || null;
  if (primary) {
    const kids = out.filter(g => g.parent_id === primary.id);
    const flags = [];
    kids.filter(k => k.state === "at_risk").forEach(k => flags.push(`${k.title} is at risk (${k.detail})`));
    if (kids.filter(k => k.state === "behind").length >= 2) flags.push("two or more supporting goals are behind");
    const unknown = kids.filter(k => k.state === "unknown").length;
    if (unknown >= 3) flags.push(`${unknown} supporting goals have too little data to judge`);
    primary.flags = flags;
    primary.needs_review = flags.some(f => !/too little data/.test(f));
  }
  return { goals: out, primary };
}

// Jeet approves the proposal → rows to insert (ids are fixed, so re-approving is a no-op).
function approvalRows(existing, now) {
  const have = new Set((existing || []).map(g => g.id));
  return PLAN.filter(p => !have.has(p.id)).map(p => Object.assign({}, p, { parent_id: p.parent_id || null, status: "active", approved_at: now, created_at: now, updated_at: now }));
}

// He can tune a supporting goal's numbers; only known keys, within sane ranges.
const TARGET_LIMITS = { kcal: [1400, 3500], rate: [0.5, 1], per_week: [1, 6], hours: [5, 10], per_days: [3, 14] };
function cleanTarget(goal, patch) {
  const t = Object.assign({}, goal.target || {});
  for (const k of Object.keys(patch || {})) {
    const lim = TARGET_LIMITS[k];
    const v = Number(patch[k]);
    if (!lim || !(k in t) || !isFinite(v) || v < lim[0] || v > lim[1]) return null;
    t[k] = v;
  }
  return t;
}

module.exports = { PLAN, STATES, graphHealth, approvalRows, cleanTarget, HEALTH };
