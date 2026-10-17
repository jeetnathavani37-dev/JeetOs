// api/_focus.js — Focus Mode (pure, no I/O).
// He picks one task and a length (10–180 min). While a session is running,
// coach nudges are held (his own schedule alarms and deadlines still come
// through), coaches are told to keep it short, and when it ends he says
// whether it got done. A session he never closes is "expired" — not counted
// as done or as given up, because we don't know.
const MIN = 10, MAX = 180, GRACE_MIN = 30;
const clip = (s, n) => String(s == null ? "" : s).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const istDay = t => new Date(t + 330 * 60000 - 4 * 3600e3).toISOString().slice(0, 10);   // before 4 AM counts as the previous day
const hm12 = t => { const d = new Date(t + 330 * 60000), h = d.getUTCHours(), m = d.getUTCMinutes(); return (h % 12 || 12) + ":" + String(m).padStart(2, "0") + (h < 12 ? " AM" : " PM"); };

// The running session, or null. A session past its end + grace is not running any more.
function activeOf(sessions, now) {
  const a = (sessions || []).find(s => s.status === "active");
  return a && now <= Date.parse(a.ends_at) + GRACE_MIN * 60000 ? a : null;
}
// Sessions left "active" long after they ended → patches marking them expired (actual time unknown).
function expirePatches(sessions, now) {
  return (sessions || []).filter(s => s.status === "active" && now > Date.parse(s.ends_at) + GRACE_MIN * 60000)
    .map(s => ({ id: s.id, patch: { status: "expired", ended_at: s.ends_at, actual_min: null, note: "not closed — unknown if it got done" } }));
}

function start(input, sessions, now) {
  const i = input || {};
  if (activeOf(sessions, now)) return { error: "a focus session is already running — finish it first" };
  const task = clip(i.task, 160), min = Math.round(+i.minutes);
  if (task.length < 2) return { error: "what will you focus on?" };
  if (!(min >= MIN && min <= MAX)) return { error: `length must be ${MIN}–${MAX} minutes` };
  return { row: { id: "f" + now.toString(36) + Math.random().toString(36).slice(2, 6), task, planned_min: min, started_at: new Date(now).toISOString(), ends_at: new Date(now + min * 60000).toISOString(), status: "active", day: istDay(now) } };
}

// outcome: done | abandoned. Actual minutes = time spent, capped at the plan (+ grace).
function end(session, outcome, note, now) {
  if (!session || session.status !== "active") return { error: "no running session" };
  if (!["done", "abandoned"].includes(outcome)) return { error: "outcome must be done or abandoned" };
  const spent = Math.max(0, Math.round((Math.min(now, Date.parse(session.ends_at) + GRACE_MIN * 60000) - Date.parse(session.started_at)) / 60000));
  return { patch: { status: outcome, ended_at: new Date(now).toISOString(), actual_min: spent, note: clip(note, 200) || null } };
}

function stats(sessions, today) {
  const ds = (sessions || []).filter(s => s.status !== "active");
  const since = new Date(Date.parse(today) - 6 * 864e5).toISOString().slice(0, 10);
  const week = ds.filter(s => String(s.day).slice(0, 10) >= since), td = ds.filter(s => String(s.day).slice(0, 10) === today);
  const mins = l => l.filter(s => s.actual_min != null).reduce((a, s) => a + s.actual_min, 0);
  const judged = week.filter(s => s.status === "done" || s.status === "abandoned");
  return {
    today_min: mins(td), today_sessions: td.length,
    week_min: mins(week), week_sessions: week.length,
    week_done_pct: judged.length >= 3 ? Math.round(judged.filter(s => s.status === "done").length / judged.length * 100) : null,
    week_judged: judged.length, week_expired: week.filter(s => s.status === "expired").length,
  };
}

// One line for coaches' context.
function focusLine(active, now) {
  if (!active) return null;
  const left = Math.max(0, Math.round((Date.parse(active.ends_at) - now) / 60000));
  return `In focus on "${active.task}" until ${hm12(Date.parse(active.ends_at))} (${left} min left). Keep replies to 1-2 lines, no new tasks, nothing that pulls him out unless it's urgent.`;
}

module.exports = { activeOf, expirePatches, start, end, stats, focusLine, MIN, MAX, GRACE_MIN };
