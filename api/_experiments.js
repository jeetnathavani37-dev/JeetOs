// api/_experiments.js — personal experiments with a pre-registered rule (pure, no I/O).
// One measured experiment at a time. When he starts one, the code freezes the
// baseline (the same number of days just before), and he states up front how
// big a change counts as "worked". At the end the code compares the two windows
// and gives the verdict — Claude never judges it. Days without data are unknown
// (not misses), recovery days are left out, and too little data = "unclear".
const { addDays } = require("./_penalty");
const { HABITS } = require("./_habits");

const day10 = d => String(d || "").slice(0, 10);
const habit = id => HABITS.find(h => h.id === id);
const morning = (raw, d, k) => { const c = (raw.dailyCheckins || []).find(x => x.kind === "morning" && day10(x.day) === d); return c && c.answers && c.answers[k] != null ? +c.answers[k] : null; };
const fromLog = k => (d, x, raw) => (x.log && x.log[k] != null && x.log[k] !== "" ? +x.log[k] : morning(raw, d, k));
const rate = id => (d, x) => { const h = habit(id); if (h.days && !h.days.includes(new Date(d + "T12:00:00Z").getUTCDay())) return undefined; return h.has(d, x) ? (h.done(d, x) ? 1 : 0) : null; };

// kind "mean" → average per day; "rate" → % of days done. step = [min, max] for the change he can ask for.
const METRICS = {
  sleep_hours: { label: "Sleep hours", unit: "h", kind: "mean", step: [0.25, 3], value: fromLog("sleep_hours") },
  bed_on_time: { label: "Sleep 6h+ & in bed by 12:30", unit: "%", kind: "rate", step: [5, 60], value: rate("sleep") },
  wake_on_time: { label: "Up by 8 AM", unit: "%", kind: "rate", step: [5, 60], value: rate("wake") },
  gym: { label: "Gym done", unit: "%", kind: "rate", step: [5, 60], value: rate("gym") },
  diet: { label: "Diet ≤2,100 kcal, no junk", unit: "%", kind: "rate", step: [5, 60], value: rate("diet") },
  kcal: { label: "Calories per day", unit: "kcal", kind: "mean", step: [50, 800], value: fromLog("total_cal") },
  energy: { label: "Energy (1-5)", unit: "/5", kind: "mean", step: [0.3, 2], value: fromLog("energy") },
  mood: { label: "Mood (1-5)", unit: "/5", kind: "mean", step: [0.3, 2], value: fromLog("mood") },
};
const DAYS = [7, 28];
const minN = days => Math.max(4, Math.ceil(days / 2));   // fewer days with data than this → can't judge

function facts(raw, d) {
  return { log: (raw.logs || []).find(l => day10(l.day) === d) || null, checkins: (raw.checkins || []).filter(c => day10(c.day) === d) };
}
// Stats for one window [from, to].
function windowStats(raw, metric, from, to) {
  const M = METRICS[metric];
  let sum = 0, n = 0, noData = 0, excused = 0, days = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if ((raw.marks || []).some(m => m.kind === "recovery" && day10(m.date) === d)) { excused++; continue; }
    const v = M.value(d, facts(raw, d), raw);
    if (v === undefined) continue;                       // not a scheduled day for this habit
    days++;
    if (v == null || !isFinite(v)) { noData++; continue; }
    sum += v; n++;
  }
  const mean = n ? (M.kind === "rate" ? Math.round(sum / n * 100) : Math.round(sum / n * 100) / 100) : null;
  return { from, to, n, days, no_data: noData, excused, mean };
}

const fmt = (metric, v) => { const M = METRICS[metric]; return v == null ? "unknown" : M.unit === "%" ? v + "%" : M.unit === "kcal" ? Math.round(v) + " kcal" : v + (M.unit === "h" ? " h" : M.unit); };

// Start: validate, freeze the baseline. Returns { row } or { error }.
function start(input, raw, today, active, nowIso) {
  const i = input || {}, M = METRICS[i.metric];
  if (active) return { error: "one experiment at a time — finish or stop the current one first" };
  if (!M) return { error: "pick a metric" };
  const action = String(i.action || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (action.length < 4) return { error: "describe the change you'll try" };
  if (!["up", "down"].includes(i.direction)) return { error: "direction must be up or down" };
  const days = Math.round(+i.days || 14), ch = +i.min_change;
  if (days < DAYS[0] || days > DAYS[1]) return { error: `length must be ${DAYS[0]}–${DAYS[1]} days` };
  if (!isFinite(ch) || ch < M.step[0] || ch > M.step[1]) return { error: `"worked" must mean a change of ${M.step[0]}–${M.step[1]} ${M.unit}` };
  const base = windowStats(raw, i.metric, addDays(today, -days), addDays(today, -1));
  if (base.n < minN(days)) return { error: `not enough data before today to compare against (${base.n} of ${days} days, need ${minN(days)}) — log for a few more days first` };
  const id = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return { row: {
    id, kind: "measured", coach: ["head", "fitness", "nutrition", "sleep", "mind", "skin", "hair", "style", "grooming", "ronaldo"].includes(i.coach) ? i.coach : "head",
    action, metric: i.metric, direction: i.direction, min_change: ch,
    target: M.label, baseline: fmt(i.metric, base.mean), criterion: `${i.direction === "up" ? "+" : "−"}${ch}${M.unit === "%" ? " points" : " " + M.unit} vs baseline`,
    base_from: base.from, base_to: base.to, test_from: today, test_to: addDays(today, days - 1), review_date: addDays(today, days),
    base_stats: base, status: "active", created_at: nowIso, updated_at: nowIso,
  } };
}

// Progress or final verdict for one experiment row.
function evaluate(e, raw, today) {
  const end = day10(e.test_to), base = e.base_stats, days = Math.round((Date.parse(end) - Date.parse(day10(e.test_from))) / 864e5) + 1;
  const test = windowStats(raw, e.metric, day10(e.test_from), today <= end ? addDays(today, -1) : end);
  const done = today > end, need = minN(days);
  const delta = test.mean != null && base && base.mean != null ? Math.round((test.mean - base.mean) * 100) / 100 : null;
  const signed = delta == null ? null : e.direction === "up" ? delta : -delta;
  const out = { test, base, delta, needed: +e.min_change, days_left: done ? 0 : Math.round((Date.parse(end) - Date.parse(today)) / 864e5) + 1, final: done };
  if (!done) return Object.assign(out, { verdict: null, text: `${test.n} days measured so far; ${out.days_left} to go. No verdict until it ends.` });
  if (test.n < need) return Object.assign(out, { verdict: "unclear", text: `Only ${test.n} days with data (need ${need}) — can't tell. Days without data aren't counted as fails.` });
  const unit = METRICS[e.metric].unit === "%" ? " points" : " " + METRICS[e.metric].unit;
  if (signed >= +e.min_change) return Object.assign(out, { verdict: "worked", text: `${fmt(e.metric, base.mean)} → ${fmt(e.metric, test.mean)} (${delta > 0 ? "+" : ""}${delta}${unit}); you said ${e.min_change}${unit} counts. It worked (n=${base.n} vs ${test.n} days — a pattern, not proof).` });
  return Object.assign(out, { verdict: "didnt", text: `${fmt(e.metric, base.mean)} → ${fmt(e.metric, test.mean)} (${delta > 0 ? "+" : ""}${delta}${unit}); needed ${e.min_change}${unit}. ${signed <= 0 ? "No improvement" : "Smaller than the bar you set"} (n=${base.n} vs ${test.n} days).` });
}

// The DB patch for a finished experiment (status 'worked' matches the coaches' count; 'didnt' is stored as 'failed').
function finalPatch(ev, nowIso) {
  return { status: ev.verdict === "worked" ? "worked" : ev.verdict === "didnt" ? "failed" : "unclear", outcome: ev.text.slice(0, 240), result: ev, decided_at: nowIso, updated_at: nowIso };
}

module.exports = { METRICS, DAYS, minN, windowStats, start, evaluate, finalPatch, fmt };
