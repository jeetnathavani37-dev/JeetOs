// api/_repair.js — automatic plan repair proposals (pure, deterministic).
// When the same anchor keeps slipping, propose a realistic new time instead
// of another reminder. Nothing changes until Jeet approves; an approved change
// applies from tomorrow only (past days and fines are never recomputed).
//
// Rule: in the last 7 scheduled days that have a check-in / meal log for that
// anchor (recovery days left out), at least 3 were late. Propose the median
// lateness rounded to 15 min, if it's 15–120 min. A rejected proposal isn't
// repeated for 14 days.
const { POLICY_V1, istAt, addDays, anchorsOn } = require("./_penalty");

const LOOKBACK = 14, WINDOW = 7, MIN_LATE = 3, MIN_SHIFT = 15, MAX_SHIFT = 120, QUIET_DAYS = 14;
const day10 = d => String(d || "").slice(0, 10);
const hmOf = mins => { const x = ((mins % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0"); };
const minsOf = hm => { const [h, m] = String(hm).split(":").map(Number); return h * 60 + m; };
const hm12 = hm => { const m = minsOf(hm), h = Math.floor(m / 60); return (h % 12 || 12) + ":" + String(m % 60).padStart(2, "0") + (h < 12 ? " AM" : " PM"); };

function actualTime(raw, key, A, d) {
  if (A.kind === "meal") {
    const l = (raw.logs || []).find(x => day10(x.day) === d);
    const t = l && l.entries_seen && l.entries_seen[key];
    return t ? Date.parse(t) : null;
  }
  const c = (raw.checkins || []).filter(x => x.anchor === key && day10(x.day) === d && x.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  return c ? Date.parse(c.at) : null;
}

function proposals(raw, today) {
  const overrides = raw.scheduleOverrides || [], rejected = (raw.schedule && raw.schedule.rejected) || [];
  const out = [];
  for (const key of Object.keys(POLICY_V1.anchors.list)) {
    if (key === "wake" || key === "sleep") continue;           // wake/sleep targets are health rules, not schedule slips
    if (overrides.some(o => o.anchor === key && String(o.from) > addDays(today, -QUIET_DAYS))) continue;   // just changed — let the new time settle
    const lates = [], samples = [];
    for (let i = 1; i <= LOOKBACK && samples.length < WINDOW; i++) {
      const d = addDays(today, -i);
      const A = anchorsOn(POLICY_V1.anchors, overrides, d).list[key];
      if (A.days && !A.days.includes(new Date(d + "T12:00:00Z").getUTCDay())) continue;
      if ((raw.marks || []).some(m => m.kind === "recovery" && day10(m.date) === d)) continue;
      const t = actualTime(raw, key, A, d);
      if (t == null) continue;                                   // no data = unknown, not a slip
      const due = istAt(A.next_day ? addDays(d, 1) : d, A.time), late = Math.round((t - due) / 60000);
      samples.push({ day: d, late });
      if (late > 0) lates.push(late);
    }
    if (lates.length < MIN_LATE) continue;
    const sorted = lates.slice().sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
    const shift = Math.round(median / 15) * 15;
    if (shift < MIN_SHIFT || shift > MAX_SHIFT) continue;
    const cur = anchorsOn(POLICY_V1.anchors, overrides, today).list[key];
    const to = hmOf(minsOf(cur.time) + shift);
    if (rejected.some(r => r.anchor === key && r.time === to && day10(r.at) >= addDays(today, -QUIET_DAYS))) continue;
    out.push({
      id: `shift:${key}:${to}`, anchor: key, label: cur.label, from_time: cur.time, to_time: to, shift_min: shift,
      evidence: { late_days: lates.length, of_days: samples.length, median_late_min: median, days: samples.map(s => s.day) },
      text: `${cur.label}: ${lates.length} of the last ${samples.length} days you were late (usually ~${median} min). Move it from ${hm12(cur.time)} to ${hm12(to)}?`,
      effect: "Applies from tomorrow. Passes and fines follow the new time; past days don't change.",
    });
  }
  return out;
}

// Approving → a new override from tomorrow, plus a journal entry so it gets reviewed.
function approve(schedule, proposal, today, nowIso) {
  const s = Object.assign({ overrides: [], rejected: [] }, schedule || {});
  const from = addDays(today, 1);
  s.overrides = (s.overrides || []).filter(o => !(o.anchor === proposal.anchor && o.from === from)).concat([{ anchor: proposal.anchor, time: proposal.to_time, from, approved_at: nowIso, was: proposal.from_time, evidence: proposal.evidence }]);
  return s;
}
function reject(schedule, proposal, nowIso) {
  const s = Object.assign({ overrides: [], rejected: [] }, schedule || {});
  s.rejected = (s.rejected || []).concat([{ anchor: proposal.anchor, time: proposal.to_time, at: nowIso }]).slice(-30);
  return s;
}
// Undo: back to the original time from tomorrow.
function revert(schedule, anchor, today, nowIso) {
  const base = POLICY_V1.anchors.list[anchor];
  if (!base) return null;
  const s = Object.assign({ overrides: [], rejected: [] }, schedule || {});
  const from = addDays(today, 1);
  s.overrides = (s.overrides || []).filter(o => !(o.anchor === anchor && o.from === from)).concat([{ anchor, time: base.time, from, approved_at: nowIso, revert: true }]);
  return s;
}

module.exports = { proposals, approve, reject, revert, MIN_LATE, WINDOW };
