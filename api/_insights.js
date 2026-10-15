// api/_insights.js — patterns in his own data (pure, deterministic).
// Every insight carries its sample sizes and is phrased as a pattern, never a
// cause. Below the minimum sample it says "not enough data" instead of guessing.
//  1. Late/short sleep → next-day gym
//  2. Weekday adherence (best vs worst day)
//  3. Morning energy → how much of the evening plan got done
//  4. Late wake → gym the same day
//  5. Approved plan changes → the related habit 14 days before vs after
const { addDays, bedMinutes } = require("./_penalty");

const MIN_EACH = 4, MIN_DIFF = 20;   // ≥4 days in each group and ≥20 points apart to call it a pattern
const day10 = d => String(d || "").slice(0, 10);
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const logOn = (raw, d) => (raw.logs || []).find(l => day10(l.day) === d) || null;
const recovery = (raw, d) => (raw.marks || []).some(m => m.kind === "recovery" && day10(m.date) === d);
const gymDay = d => new Date(d + "T12:00:00Z").getUTCDay() !== 0;
const gymDone = (raw, d) => (raw.checkins || []).some(c => c.anchor === "gym" && day10(c.day) === d) || !!(logOn(raw, d) && logOn(raw, d).gym_done);
const gymKnown = (raw, d) => !!logOn(raw, d) || (raw.checkins || []).some(c => day10(c.day) === d);
function goodNight(l) {
  if (!l || l.sleep_hours == null) return null;
  const b = l.bedtime ? bedMinutes(l.bedtime) : null;
  return +l.sleep_hours >= 6 && (b == null || b <= 30 || b >= 18 * 60);
}
const pct = (a, n) => (n ? Math.round(a / n * 100) : null);
const days = (today, n) => Array.from({ length: n }, (_, i) => addDays(today, -(i + 1)));

function compare(id, groupA, groupB, labelA, labelB, what) {
  const a = groupA.filter(Boolean).length, b = groupB.filter(Boolean).length;
  const res = { id, n: { [labelA]: groupA.length, [labelB]: groupB.length }, rate: { [labelA]: pct(a, groupA.length), [labelB]: pct(b, groupB.length) } };
  if (groupA.length < MIN_EACH || groupB.length < MIN_EACH) return Object.assign(res, { enough: false, text: `${what}: not enough data yet (${groupA.length} ${labelA} vs ${groupB.length} ${labelB} days; need ${MIN_EACH} each)` });
  const diff = res.rate[labelA] - res.rate[labelB];
  res.enough = true; res.diff = diff; res.notable = Math.abs(diff) >= MIN_DIFF;
  res.text = `${what}: ${res.rate[labelA]}% after ${labelA} days (n=${groupA.length}) vs ${res.rate[labelB]}% after ${labelB} days (n=${groupB.length})` + (res.notable ? "" : " — no clear difference");
  return res;
}

function sleepToGym(raw, today) {
  const good = [], bad = [];
  days(today, 30).forEach(d => {
    if (!gymDay(d) || recovery(raw, d) || !gymKnown(raw, d)) return;
    const night = goodNight(logOn(raw, d));          // the log on day D holds the night before D
    if (night === null) return;
    (night ? good : bad).push(gymDone(raw, d));
  });
  return compare("sleep_gym", good, bad, "good-sleep", "late/short-sleep", "Gym next day");
}

function lateWakeToGym(raw, today) {
  const early = [], late = [];
  days(today, 30).forEach(d => {
    if (!gymDay(d) || recovery(raw, d)) return;
    const w = (raw.checkins || []).find(c => c.anchor === "wake" && day10(c.day) === d && c.at);
    if (!w) return;
    const hm = new Date(Date.parse(w.at) + 330 * 60000).toISOString().slice(11, 16);
    (hm <= "08:00" ? early : late).push(gymDone(raw, d));
  });
  return compare("wake_gym", early, late, "on-time-wake", "late-wake", "Gym the same day");
}

function energyToDone(raw, today) {
  const hi = [], lo = [];
  days(today, 30).concat([today]).forEach(d => {
    const m = (raw.dailyCheckins || []).find(c => c.kind === "morning" && day10(c.day) === d);
    const e = (raw.dailyCheckins || []).find(c => c.kind === "evening" && day10(c.day) === d);
    if (!m || !e || !m.answers || m.answers.energy == null || !e.answers) return;
    const done = (e.answers.done || []).length, total = done + (e.answers.not_done || []).length;
    if (!total) return;
    (+m.answers.energy >= 3 ? hi : lo).push(done / total >= 0.67);
  });
  return compare("energy_done", hi, lo, "energy-3+", "energy-1-2", "Most of the plan done");
}

function weekdays(raw, today) {
  const by = {};
  days(today, 28).forEach(d => {
    if (recovery(raw, d)) return;
    const l = logOn(raw, d);
    const parts = [];
    if (gymDay(d) && gymKnown(raw, d)) parts.push(gymDone(raw, d));
    if (l && l.total_cal != null) parts.push(+l.total_cal <= 2100 && !(+l.junk_meals > 0));
    const n = goodNight(l); if (n !== null) parts.push(n);
    if (!parts.length) return;
    const k = new Date(d + "T12:00:00Z").getUTCDay();
    (by[k] = by[k] || []).push(parts.filter(Boolean).length / parts.length);
  });
  const rows = Object.keys(by).filter(k => by[k].length >= 3).map(k => ({ day: DOW[k], n: by[k].length, score: Math.round(by[k].reduce((a, b) => a + b, 0) / by[k].length * 100) }));
  if (rows.length < 3) return { id: "weekday", enough: false, text: `Weekday pattern: not enough data yet (${rows.length} weekdays with 3+ logged days)` };
  rows.sort((a, b) => b.score - a.score);
  const best = rows[0], worst = rows[rows.length - 1], notable = best.score - worst.score >= MIN_DIFF;
  return { id: "weekday", enough: true, notable, rows, text: `Weekdays: best ${best.day} ${best.score}% (n=${best.n}), worst ${worst.day} ${worst.score}% (n=${worst.n})` + (notable ? "" : " — fairly even") };
}

// Approved plan changes: the related habit 14 days before vs 14 days after.
const AREA_HABIT = [[/diet|nutri|food|cal/i, "diet"], [/gym|fitness|train|workout/i, "gym"], [/sleep|bed/i, "sleep"]];
function habitDone(raw, d, h) {
  if (recovery(raw, d)) return null;
  const l = logOn(raw, d);
  if (h === "gym") return gymDay(d) && gymKnown(raw, d) ? gymDone(raw, d) : null;
  if (h === "diet") return l && l.total_cal != null ? +l.total_cal <= 2100 && !(+l.junk_meals > 0) : null;
  return goodNight(l);
}
function interventions(raw, today) {
  return (raw.decisions || []).filter(x => x.decided_at && (x.status === "approved" || !x.status)).map(x => {
    const hit = AREA_HABIT.find(([re]) => re.test(`${x.area || ""} ${x.change || ""}`));
    if (!hit) return null;
    const h = hit[1], at = day10(x.decided_at), before = [], after = [];
    for (let i = 1; i <= 14; i++) {
      const b = habitDone(raw, addDays(at, -i), h); if (b !== null) before.push(b);
      const a = addDays(at, i - 1); if (a < today) { const v = habitDone(raw, a, h); if (v !== null) after.push(v); }
    }
    const c = compare("decision:" + (x.id || at), after, before, "after", "before", `"${String(x.change).slice(0, 60)}" (${at}) → ${h}`);
    if (c.enough) c.text = `"${String(x.change).slice(0, 60)}" (${at}) → ${h}: ${c.rate.after}% in the days after (n=${after.length}) vs ${c.rate.before}% in the 14 days before (n=${before.length})` + (c.notable ? "" : " — no clear change");
    return Object.assign(c, { decision: x.id || null, habit: h });
  }).filter(Boolean).slice(0, 4);
}

function insightReport(raw, today) {
  const all = [sleepToGym(raw, today), lateWakeToGym(raw, today), energyToDone(raw, today), weekdays(raw, today)].concat(interventions(raw, today));
  return { insights: all.filter(i => i.enough && i.notable), steady: all.filter(i => i.enough && !i.notable), waiting: all.filter(i => !i.enough) };
}
function insightLines(rep) {
  return rep.insights.map(i => i.text + " (pattern, not proof of cause)").concat(rep.waiting.length ? [`still collecting data for: ${rep.waiting.map(w => w.id.replace(/^decision:.*/, "a plan change")).join(", ")}`] : []);
}

module.exports = { insightReport, insightLines, MIN_EACH, MIN_DIFF };
