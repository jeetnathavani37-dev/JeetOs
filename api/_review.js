// api/_review.js — the Weekly CEO Review (pure numbers + one guarded Claude call).
// Covers the last finished Sun–Sat week (on Sunday: the 7 days ending yesterday).
// The CODE computes every number: planned vs done, anchors on time, habits vs
// the week before, weight trend, promises, fines, recurring blockers, plans that
// keep failing, decisions waiting on him, and next week's top 3. Claude only
// writes a short narrative around those numbers — a narrative that mentions a
// number not in the facts is thrown away. Missing data stays "unknown".
const { POLICY_V1, istAt, addDays, anchorsOn, meanWindow, rupees } = require("./_penalty");
const { HABITS, windowStats } = require("./_habits");
const { graphHealth } = require("./_goals");
const repair = require("./_repair");

const day10 = d => String(d || "").slice(0, 10);
const pct = (a, b) => (b ? Math.round(a / b * 100) : null);

// The week this review is about: Sun..Sat ending on the last Saturday before `today`.
function reviewWeek(today) {
  const dow = new Date(today + "T12:00:00Z").getUTCDay();
  const end = addDays(today, -(((dow + 1) % 7) || 7));
  return { start: addDays(end, -6), end };
}
const daysOf = (start, end) => { const out = []; for (let d = start; d <= end; d = addDays(d, 1)) out.push(d); return out; };
const isRecovery = (raw, d) => (raw.marks || []).some(m => m.kind === "recovery" && day10(m.date) === d);

// Anchors: on days with any data, how many scheduled anchors were done / on time.
function anchorWeek(raw, start, end) {
  let scheduled = 0, done = 0, onTime = 0, noData = 0, excused = 0;
  const lateBy = {};
  for (const d of daysOf(start, end)) {
    if (isRecovery(raw, d)) { excused++; continue; }
    const log = (raw.logs || []).find(l => day10(l.day) === d) || null;
    const cks = (raw.checkins || []).filter(c => day10(c.day) === d);
    if (!log && !cks.length) { noData++; continue; }               // no data that day = unknown, not missed
    const dow = new Date(d + "T12:00:00Z").getUTCDay(), list = anchorsOn(POLICY_V1.anchors, raw.scheduleOverrides, d).list;
    for (const key of Object.keys(list)) {
      const A = list[key];
      if (A.days && !A.days.includes(dow)) continue;
      scheduled++;
      const t = A.kind === "meal" ? (log && log.entries_seen && log.entries_seen[key] ? Date.parse(log.entries_seen[key]) : null)
        : (cks.filter(c => c.anchor === key && c.at).map(c => Date.parse(c.at)).sort((a, b) => a - b)[0] || (cks.some(c => c.anchor === key) ? NaN : null));
      if (t == null) { lateBy[key] = (lateBy[key] || 0) + 1; continue; }
      done++;
      if (isNaN(t) || t <= istAt(A.next_day ? addDays(d, 1) : d, A.time) + A.ext_min * 60000) onTime++;
      else lateBy[key] = (lateBy[key] || 0) + 1;
    }
  }
  const worst = Object.keys(lateBy).sort((a, b) => lateBy[b] - lateBy[a]).filter(k => lateBy[k] >= 2).slice(0, 3)
    .map(k => ({ anchor: k, label: POLICY_V1.anchors.list[k].label, times: lateBy[k] }));
  return { scheduled, done, on_time: onTime, pct_on_time: pct(onTime, scheduled), no_data_days: noData, excused_days: excused, missed_or_late: lateBy, slipping: worst };
}

// His own evening check-ins: what he planned vs what he ticked, and why things didn't happen.
function eveningWeek(raw, start, end) {
  const ev = (raw.dailyCheckins || []).filter(c => c.kind === "evening" && day10(c.day) >= start && day10(c.day) <= end);
  let planned = 0, done = 0;
  const reasons = {}, missed = {};
  ev.forEach(c => {
    const a = c.answers || {}, d = (a.done || []).length, nd = (a.not_done || []).length;
    planned += d + nd; done += d;
    if (a.blocker) reasons[a.blocker] = (reasons[a.blocker] || 0) + 1;
    (a.not_done || []).forEach(t => { const k = String(t).replace(/ at .*| \(.*\)| —.*/g, "").trim(); missed[k] = (missed[k] || 0) + 1; });
  });
  const rec = o => Object.keys(o).filter(k => o[k] >= 2).sort((a, b) => o[b] - o[a]).slice(0, 3).map(k => ({ what: k, times: o[k] }));
  return { evenings: ev.length, planned, done, pct_done: planned ? pct(done, planned) : null, blockers: rec(reasons), missed_again: rec(missed) };
}

function habitWeek(raw, start, end) {
  return HABITS.map(h => {
    const cur = windowStats(h, raw, addDays(end, 1), 7), prev = windowStats(h, raw, start, 7);
    const change = cur.enough && prev.enough ? cur.pct - prev.pct : null;
    return { id: h.id, label: h.label, pct: cur.enough ? cur.pct : null, n: cur.n, prev_pct: prev.enough ? prev.pct : null, change };
  });
}

// extra: { closed: commitments resolved in the week, pending: decisions waiting, entries: ledger entries in the week, failed: [] }
function buildReview(raw, today, extra) {
  extra = extra || {};
  const { start, end } = reviewWeek(today);
  const unknown = [].concat(raw.failed || [], extra.failed || []);
  const anchors = anchorWeek(raw, start, end), evening = eveningWeek(raw, start, end), habits = habitWeek(raw, start, end);
  const wNow = meanWindow(raw.weighins || [], end, 7), wPrev = meanWindow(raw.weighins || [], addDays(end, -7), 7);
  const weight = { avg_kg: wNow, prev_avg_kg: wPrev, change_kg: wNow != null && wPrev != null ? Math.round((wNow - wPrev) * 100) / 100 : null,
    weighins: (raw.weighins || []).filter(w => day10(w.day) >= start && day10(w.day) <= end).length };
  const closed = (extra.closed || []).filter(c => c.owner !== "coach");
  const promises = { done: closed.filter(c => c.status === "done").length, missed: closed.filter(c => c.status === "missed").length,
    overdue_now: (raw.openPromises || []).filter(c => c.owner !== "coach" && c.due && c.due <= end).length };
  const fines = extra.entries ? { paise: extra.entries.reduce((a, e) => a + Number(e.amount_paise || 0), 0), entries: extra.entries.length } : null;
  const health = (raw.graph || []).length ? graphHealth(raw.graph, raw, today) : null;
  const primary = health && health.primary ? { title: health.primary.title, state: health.primary.state, detail: health.primary.detail, flags: health.primary.flags || [] } : null;
  const atRisk = health ? health.goals.filter(g => g.kind !== "primary" && (g.state === "at_risk" || g.state === "behind")).map(g => ({ title: g.title, state: g.state, detail: g.detail })) : [];
  const repairs = repair.proposals(raw, today);
  const pending = (extra.pending || []).map(d => ({ id: d.id, coach: d.coach, change: d.change }));
  const journalDue = (raw.decisions || []).filter(d => d.review_on && day10(d.review_on) <= today && !d.verdict).map(d => ({ id: d.id, change: d.change }));

  // Wins: only things the numbers back.
  const wins = [];
  if (weight.change_kg != null && weight.change_kg < 0) wins.push(`weekly average weight down ${Math.abs(weight.change_kg)} kg`);
  if (anchors.pct_on_time != null && anchors.pct_on_time >= 80) wins.push(`${anchors.pct_on_time}% of anchors on time`);
  if (promises.done) wins.push(`${promises.done} promise${promises.done > 1 ? "s" : ""} kept`);
  habits.filter(h => h.change != null && h.change >= 15).forEach(h => wins.push(`${h.label} up from ${h.prev_pct}% to ${h.pct}%`));
  habits.filter(h => h.pct != null && h.pct >= 80 && !(h.change >= 15)).forEach(h => wins.push(`${h.label}: ${h.pct}% of days (n=${h.n})`));

  // Plans that keep failing → they need a different plan, not more willpower.
  const unrealistic = [];
  repairs.forEach(r => unrealistic.push({ what: r.label, why: `late ${r.evidence.late_days} of ${r.evidence.of_days} days`, fix: `move to ${r.to_time}` }));
  evening.missed_again.forEach(m => unrealistic.push({ what: m.what, why: `left undone on ${m.times} evenings`, fix: null }));
  anchors.slipping.filter(s => !repairs.some(r => r.anchor === s.anchor)).forEach(s => unrealistic.push({ what: s.label, why: `missed or late ${s.times} times this week`, fix: null }));

  // Next week's top 3, in a fixed order of importance.
  const cand = [];
  atRisk.filter(g => g.state === "at_risk").forEach(g => cand.push({ title: `Get "${g.title}" back on track`, why: g.detail || "at risk" }));
  repairs.forEach(r => cand.push({ title: `Decide: move ${r.label} to ${r.to_time}?`, why: `late ${r.evidence.late_days} of ${r.evidence.of_days} days` }));
  const weak = habits.filter(h => h.pct != null && h.pct < 70).sort((a, b) => a.pct - b.pct)[0];
  if (weak) cand.push({ title: `Raise ${weak.label} from ${weak.pct}%`, why: `the weakest habit this week (n=${weak.n})` });
  if (evening.blockers[0]) cand.push({ title: `Plan around "${evening.blockers[0].what}"`, why: `the reason on ${evening.blockers[0].times} evenings` });
  if (weight.avg_kg == null) cand.push({ title: "3 fasted morning weigh-ins", why: "no weight data this week — the primary goal can't be judged" });
  if (pending.length) cand.push({ title: `Approve or decline ${pending.length} coach proposal${pending.length > 1 ? "s" : ""}`, why: "waiting on you" });
  atRisk.filter(g => g.state === "behind").forEach(g => cand.push({ title: `Catch up on "${g.title}"`, why: g.detail || "behind" }));
  if (evening.evenings < 3) cand.push({ title: "Do the evening check-in at least 5 days", why: `only ${evening.evenings} this week — the review needs it` });
  const seen = new Set(), top3 = cand.filter(c => !seen.has(c.title) && seen.add(c.title)).slice(0, 3);

  return { week_start: start, week_end: end, anchors, evening, habits, weight, promises, fines, primary, at_risk: atRisk,
    wins: wins.slice(0, 5), unrealistic: unrealistic.slice(0, 4), next_top3: top3, pending, journal_due: journalDue, unknown };
}

// Plain fact lines — the only thing Claude sees, and what its numbers are checked against.
function factLines(r) {
  const L = [`WEEK ${r.week_start} to ${r.week_end}`];
  const a = r.anchors;
  L.push(a.scheduled ? `Anchors: ${a.on_time} of ${a.scheduled} on time (${a.pct_on_time}%), ${a.done} done` : "Anchors: no data");
  if (a.no_data_days) L.push(`Days with no data: ${a.no_data_days} (unknown, not missed)`);
  if (a.excused_days) L.push(`Recovery days: ${a.excused_days}`);
  const e = r.evening;
  L.push(e.planned ? `Plan items done (his evening check-ins): ${e.done} of ${e.planned} (${e.pct_done}%), ${e.evenings} evenings` : `Evening check-ins: ${e.evenings}`);
  r.habits.forEach(h => L.push(`${h.label}: ${h.pct == null ? `not enough data (n=${h.n})` : `${h.pct}% (n=${h.n})`}${h.prev_pct != null ? `, week before ${h.prev_pct}%` : ""}`));
  const w = r.weight;
  L.push(w.avg_kg == null ? "Weight: no qualifying weigh-ins this week" : `Weight 7-day average: ${w.avg_kg} kg${w.prev_avg_kg != null ? ` (week before ${w.prev_avg_kg} kg, change ${w.change_kg} kg)` : ""}`);
  if (r.primary) L.push(`Primary goal "${r.primary.title}": ${r.primary.state}${r.primary.detail ? ` — ${r.primary.detail}` : ""}`);
  r.at_risk.forEach(g => L.push(`Goal "${g.title}": ${g.state}${g.detail ? ` — ${g.detail}` : ""}`));
  L.push(`Promises: ${r.promises.done} kept, ${r.promises.missed} missed, ${r.promises.overdue_now} still overdue`);
  if (r.fines) L.push(`Ledger entries this week: ${rupees(r.fines.paise)}`);
  r.evening.blockers.forEach(b => L.push(`Blocker "${b.what}": ${b.times} evenings`));
  r.unrealistic.forEach(u => L.push(`Keeps failing: ${u.what} (${u.why})${u.fix ? ` — proposal: ${u.fix}` : ""}`));
  r.next_top3.forEach((t, i) => L.push(`Next week #${i + 1}: ${t.title} (${t.why})`));
  if (r.pending.length) L.push(`Waiting for his approval: ${r.pending.length}`);
  if (r.unknown.length) L.push(`Couldn't read: ${r.unknown.join(", ")}`);
  return L;
}

// Numbers with their unit ("79.5kg", "100%", "₹200", "12:30"), so "12 kg" can't hide behind "12:30".
const nums = s => (String(s).match(/(?:₹\s?)?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|kg)|:\d{2})?/gi) || []).map(x => x.replace(/[\s,]/g, "").toLowerCase());
// Every number in the narrative must appear in the facts (bare 0-3 are fine: "ek", "do"…).
function numbersOk(text, facts) {
  const have = new Set(), bare = n => n.replace(/^₹|%$|kg$|:\d{2}$/g, "");
  nums(facts.join("\n")).forEach(n => { have.add(n); have.add(bare(n)); });
  return nums(text).every(n => have.has(n) || /^[0-3]$/.test(n));   // a number with a unit must match with that unit
}

function narrativePrompt(lines) {
  return {
    system: `You are Jeet's Head Coach writing his WEEKLY CEO REVIEW summary. The numbers below are final — computed by code from his own data.
Rules: use ONLY these facts; never add or change a number; missing data is unknown, not failure; no guilt, no lecture.
Write 4 short lines in Hinglish: 1) how the week went overall, 2) the biggest win, 3) the one thing that kept breaking and why, 4) the focus for next week (from "Next week #1").

FACTS:
${lines.join("\n")}`,
    user: "Write the summary.",
  };
}

async function narrate(review, callClaude) {
  const lines = factLines(review), p = narrativePrompt(lines);
  try {
    const t = String(await callClaude(p.system, p.user, 600) || "").replace(/<[^>]*>/g, "").trim().slice(0, 900);
    if (!t) return { narrative: null, ai: false };
    if (!numbersOk(t, lines)) return { narrative: null, ai: false, rejected: "used a number that isn't in the data" };
    return { narrative: t, ai: true };
  } catch (_) { return { narrative: null, ai: false }; }
}

// Stored once per week. q(path) → rows|null; write(path, body, headers) → { ok, status, body }.
async function ensureReview({ q, write, callClaude, now, source }) {
  const { loadContextData, planDay } = require("./_context");
  now = now || Date.now();
  const today = planDay(now), { start, end } = reviewWeek(today);
  const have = await q(`jeetos_weekly_reviews?week_end=eq.${end}&select=*`);
  if (Array.isArray(have) && have.length) return { review: have[0], created: false };
  const [raw, closed, pending, entries] = await Promise.all([
    loadContextData(q, now),
    q(`jeetos_commitments?status=in.(done,missed)&resolved_at=gte.${encodeURIComponent(start + "T00:00:00+05:30")}&resolved_at=lt.${encodeURIComponent(addDays(end, 1) + "T00:00:00+05:30")}&select=owner,status,text&limit=100`),
    q("jeetos_decisions?status=eq.pending&select=id,coach,change&order=created_at.desc&limit=20"),
    q(`jeetos_penalty_entries?local_date=gte.${start}&local_date=lte.${end}&select=amount_paise`),
  ]);
  const failed = [];
  if (!Array.isArray(closed)) failed.push("closedPromises(week)");
  if (!Array.isArray(pending)) failed.push("pendingDecisions");
  if (!Array.isArray(entries)) failed.push("ledger");
  const data = buildReview(raw, today, { closed: closed || [], pending: pending || [], entries: Array.isArray(entries) ? entries : null, failed });
  const n = await narrate(data, callClaude);
  const row = { week_end: end, week_start: start, data, narrative: n.narrative, ai: n.ai, source: source || "server", created_at: new Date(now).toISOString() };
  if (n.rejected) row.data = Object.assign({}, data, { narrative_rejected: n.rejected });
  const w = await write("jeetos_weekly_reviews?on_conflict=week_end", row, { Prefer: "resolution=ignore-duplicates,return=representation" });
  if (!w.ok) return { review: row, created: false, error: "couldn't save (" + w.status + ")" };
  if (!(Array.isArray(w.body) && w.body.length)) return { review: ((await q(`jeetos_weekly_reviews?week_end=eq.${end}&select=*`)) || [])[0] || row, created: false };
  return { review: row, created: true };
}

module.exports = { reviewWeek, anchorWeek, eveningWeek, habitWeek, buildReview, factLines, numbersOk, narrate, ensureReview };
