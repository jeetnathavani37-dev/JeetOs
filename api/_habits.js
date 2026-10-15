// api/_habits.js — habit consistency (pure, no I/O).
// Not just streaks: % of days done over 7 and 30 days, counted only on days
// that have data (missing = unknown, not a miss), with recovery days excused
// and minimum versions credited. Plus the most common reasons for misses
// from his own evening check-ins. One bad day never wipes out a good week.
const { addDays, bedMinutes } = require("./_penalty");

const day10 = d => String(d || "").slice(0, 10);
const MIN_N = { 7: 3, 30: 8 };   // fewer days with data than this → "not enough data"

const HABITS = [
  { id: "gym", label: "Gym", days: [1, 2, 3, 4, 5, 6], streakKey: "move",
    has: (d, x) => x.log != null || x.checkins.length > 0,
    done: (d, x) => x.checkins.some(c => c.anchor === "gym") || !!(x.log && x.log.gym_done) },
  { id: "diet", label: "Diet (≤2,100 kcal, no junk)", streakKey: "food",
    has: (d, x) => !!(x.log && x.log.total_cal != null),
    done: (d, x) => +x.log.total_cal <= 2100 && !(+x.log.junk_meals > 0) },
  { id: "sleep", label: "Sleep (6h+, in bed by 12:30)", streakKey: "sleep",
    has: (d, x) => !!(x.log && x.log.sleep_hours != null),
    done: (d, x) => { const b = x.log.bedtime ? bedMinutes(x.log.bedtime) : null; return +x.log.sleep_hours >= 6 && (b == null || b <= 30 || b >= 18 * 60); } },
  { id: "wake", label: "Up by 8 AM",
    has: (d, x) => x.checkins.some(c => c.anchor === "wake"),
    done: (d, x) => x.checkins.some(c => c.anchor === "wake" && c.at && new Date(Date.parse(c.at) + 330 * 60000).toISOString().slice(11, 16) <= "08:00") },
  { id: "skincare", label: "Skincare",
    has: (d, x) => x.log != null,
    done: (d, x) => !!(x.log && x.log.skincare_done) },
  { id: "logging", label: "Logged the day",
    has: () => true,
    done: (d, x) => !!(x.log && (x.log.total_cal != null || x.log.sleep_hours != null || x.log.gym_done)) },
];

function dayFacts(raw, d) {
  return {
    log: (raw.logs || []).find(l => day10(l.day) === d) || null,
    checkins: (raw.checkins || []).filter(c => day10(c.day) === d),
    marks: (raw.marks || []).filter(m => day10(m.date) === d),
  };
}

function windowStats(h, raw, today, n) {
  let eligible = 0, done = 0, minimum = 0, excused = 0, noData = 0;
  for (let i = 1; i <= n; i++) {          // finished days only (today is still in progress)
    const d = addDays(today, -i), dow = new Date(d + "T12:00:00Z").getUTCDay();
    if (h.days && !h.days.includes(dow)) continue;
    const x = dayFacts(raw, d);
    if (x.marks.some(m => m.kind === "recovery")) { excused++; continue; }
    const minMark = h.streakKey && x.marks.some(m => m.kind === "min" && m.habit === h.streakKey);
    if (!h.has(d, x) && !minMark) { noData++; continue; }
    eligible++;
    if (h.has(d, x) && h.done(d, x)) done++;
    else if (minMark) { minimum++; done += 0.5; }   // the minimum version counts half — it keeps the habit alive
  }
  const pct = eligible ? Math.round(done / eligible * 100) : null;
  return { n: eligible, pct: eligible >= MIN_N[n] ? pct : null, done, minimum, excused, noData, enough: eligible >= MIN_N[n] };
}

// Most common reasons for misses (his own evening answers), last 30 days.
function blockers(raw, today) {
  const from = addDays(today, -30), counts = {}, missed = {};
  (raw.dailyCheckins || []).filter(c => c.kind === "evening" && day10(c.day) >= from).forEach(c => {
    const a = c.answers || {};
    if (a.blocker) counts[a.blocker] = (counts[a.blocker] || 0) + 1;
    (a.not_done || []).forEach(t => { const k = String(t).replace(/ at .*| \(.*\)| —.*/g, "").trim(); missed[k] = (missed[k] || 0) + 1; });
  });
  const top = o => Object.keys(o).sort((a, b) => o[b] - o[a]).slice(0, 3).map(k => ({ what: k, times: o[k] }));
  return { reasons: top(counts), missed: top(missed), evenings: (raw.dailyCheckins || []).filter(c => c.kind === "evening" && day10(c.day) >= from).length };
}

function habitReport(raw, today) {
  const habits = HABITS.map(h => {
    const w7 = windowStats(h, raw, today, 7), w30 = windowStats(h, raw, today, 30);
    let trend = null;
    if (w7.enough && w30.enough) trend = w7.pct - w30.pct >= 10 ? "up" : w30.pct - w7.pct >= 10 ? "down" : "steady";
    return { id: h.id, label: h.label, d7: w7, d30: w30, trend };
  });
  return { habits, blockers: blockers(raw, today) };
}

function habitLines(rep) {
  const pc = w => (w.enough ? `${w.pct}%` : `not enough data (n=${w.n})`);
  const lines = rep.habits.map(h => `${h.label}: 7d ${pc(h.d7)}, 30d ${pc(h.d30)}${h.trend ? ` (${h.trend})` : ""}${h.d7.minimum ? `, ${h.d7.minimum} minimum-version day(s)` : ""}`);
  const b = rep.blockers;
  if (b.reasons.length) lines.push(`why things get missed (his evening answers, ${b.evenings} evenings): ${b.reasons.map(r => `${r.what} ×${r.times}`).join(", ")}${b.missed.length ? `; most missed: ${b.missed.map(m => `${m.what} ×${m.times}`).join(", ")}` : ""} — patterns, not proof of cause`);
  return lines;
}

module.exports = { habitReport, habitLines, HABITS, windowStats };
