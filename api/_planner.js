// api/_planner.js — the adaptive daily plan (pure, deterministic).
// From his anchors, promises, goal health and today's check-in it builds:
//   top3      the three things that matter most right now (with why)
//   changes   what moved or was dropped after a miss — the day is never "lost"
//   risks     what's at risk today
//   free      free windows left today
// Claude never invents time slots; it only gets this plan to explain.
const { POLICY_V1, istAt, addDays } = require("./_penalty");

// How long each part of his day takes (minutes). Work runs until "leave".
const BLOCK = { gym: 90, breakfast: 30, lunch: 30, snack: 15, dinner: 30 };
const GYM_MIN = 45, HOME_WORKOUT = 20, GYM_LATEST_END = "22:45";   // later training hurts his 12:30 sleep

const hm12 = t => { const d = new Date(t + 330 * 60000), h = d.getUTCHours(), m = d.getUTCMinutes(); return (h % 12 || 12) + ":" + String(m).padStart(2, "0") + (h < 12 ? " AM" : " PM"); };
const at = (day, hm, nextDay) => istAt(nextDay ? addDays(day, 1) : day, hm);

// Busy blocks for the plan day (ms timestamps), from his own schedule.
function busyBlocks(day, anchors, opts) {
  const L = (opts.AN || POLICY_V1.anchors).list, dow = new Date(day + "T12:00:00Z").getUTCDay(), on = k => !L[k].days || L[k].days.includes(dow);
  const out = [];
  if (on("gym") && !opts.skipGym) out.push({ key: "gym", from: at(day, L.gym.time), to: at(day, L.gym.time) + BLOCK.gym * 60000 });
  out.push({ key: "breakfast", from: at(day, L.breakfast.time), to: at(day, L.breakfast.time) + BLOCK.breakfast * 60000 });
  if (on("work")) out.push({ key: "work", from: at(day, L.work.time), to: at(day, L.leave.time) });
  else {
    out.push({ key: "lunch", from: at(day, L.lunch.time), to: at(day, L.lunch.time) + BLOCK.lunch * 60000 });
    out.push({ key: "snack", from: at(day, L.snack.time), to: at(day, L.snack.time) + BLOCK.snack * 60000 });
  }
  out.push({ key: "dinner", from: at(day, L.dinner.time), to: at(day, L.dinner.time) + BLOCK.dinner * 60000 });
  return out.sort((a, b) => a.from - b.from);
}
// Free windows between now and bedtime.
function freeWindows(day, now, busy, AN) {
  const L = (AN || POLICY_V1.anchors).list;
  const end = at(day, L.sleep.time, L.sleep.next_day);
  let t = Math.max(now, at(day, L.wake.time));
  const out = [];
  for (const b of busy) {
    if (b.to <= t) continue;
    if (b.from > t) out.push({ from: t, to: Math.min(b.from, end) });
    t = Math.max(t, b.to);
    if (t >= end) break;
  }
  if (t < end) out.push({ from: t, to: end });
  return out.filter(w => w.to - w.from >= 15 * 60000);
}
const fits = (wins, min, after, latestEnd) => wins.find(w => Math.max(w.from, after) + min * 60000 <= Math.min(w.to, latestEnd || Infinity));

// health: { gym: "at_risk", diet: ..., sleep: ..., weighin: ... } (from the goal graph; optional)
function planToday(input) {
  const { day, now, AN = null, anchors = [], promises = [], health = {}, todayPriority = null, recovery = false, checkin = null, log = null, lastWeighinDay = null } = input;
  const A = Object.fromEntries(anchors.map(a => [a.key, a]));
  const items = [], changes = [], risks = [];
  const push = (prio, title, why, extra) => items.push(Object.assign({ prio, title, why }, extra || {}));

  // 1. Anything in its extension window right now.
  anchors.filter(a => a.state === "in extension").forEach(a => push(1, `${a.label} — now`, `in the extension window until ${hm12(a.end)}; after that it costs ₹100`, { kind: "anchor", key: a.key, until: a.end }));
  // 2. His promises due today or overdue.
  promises.filter(c => c.owner !== "coach" && c.due && c.due <= day).forEach(c => push(c.staked ? 1.5 : 2, c.text, c.due < day ? `overdue since ${c.due}` : "promised for today" + (c.staked ? " (staked)" : ""), { kind: "promise", id: c.id }));
  // 3. Today's one priority.
  if (todayPriority && !todayPriority.done) push(2.5, todayPriority.text, "today's one priority (from the team huddle)", { kind: "priority" });

  // 4. Adapt after misses — find a new slot instead of writing the day off.
  const gymMissed = A.gym && A.gym.state === "not checked in" && !(log && log.gym_done);
  const busy = busyBlocks(day, anchors, { AN, skipGym: !!gymMissed || (A.gym && A.gym.state === "done") });
  const free = freeWindows(day, now, busy, AN);
  const lowEnergy = checkin && checkin.energy != null && +checkin.energy <= 2;
  if (gymMissed && !recovery) {
    const slot = !lowEnergy && fits(free, GYM_MIN, now + 15 * 60000, at(day, GYM_LATEST_END));
    if (slot) {
      const from = Math.max(slot.from, now + 15 * 60000);
      changes.push({ type: "moved", what: "Gym", to: hm12(from), text: `Gym missed at ${A.gym.time} → moved to ${hm12(from)}–${hm12(from + GYM_MIN * 60000)} (${GYM_MIN} min)` });
      push(health.gym === "at_risk" ? 2 : 3, `Gym at ${hm12(from)} (${GYM_MIN} min)`, "the 9:30 slot was missed; this is the next free window" + (health.gym === "at_risk" ? " — gym goal is at risk this week" : ""), { kind: "repair", key: "gym", at: from });
    } else {
      const left = fits(free, HOME_WORKOUT, now);
      if (left) {
        changes.push({ type: "minimum", what: "Gym", text: `No ${GYM_MIN}-min window left${lowEnergy ? " (and energy is low)" : ""} → ${HOME_WORKOUT}-min home workout instead (minimum version keeps the streak)` });
        push(3, `${HOME_WORKOUT}-min home workout`, "minimum version of today's gym", { kind: "repair", key: "gym" });
      } else changes.push({ type: "dropped", what: "Gym", text: "No time left for gym today — dropped. Mark it honestly; tomorrow 9:30 AM." });
    }
  }
  if (A.work && A.work.state === "not checked in" && A.leave && now < A.leave.due) {
    const hrs = Math.round((A.leave.due - now) / 36e5 * 10) / 10;
    if (hrs >= 1) { changes.push({ type: "shortened", what: "Library", text: `Library start missed → still ${hrs}h of study possible before ${A.leave.time}` }); push(3, `Library now — ${hrs}h left`, "the 12:30 start was missed; the rest of the session still counts", { kind: "repair", key: "work" }); }
  }
  ["breakfast", "lunch", "dinner"].forEach(k => { if (A[k] && A[k].state === "not checked in") push(5, `Log ${A[k].label.toLowerCase()} if you ate`, "no meal logged — unknown, not missed", { kind: "log", key: k }); });

  // 5. Protect goals that are at risk.
  if (health.diet === "at_risk") push(3.5, "Stay ≤ 2,100 kcal today and log every meal", "diet goal is at risk this week", { kind: "goal", key: "diet" });
  if (health.sleep === "at_risk" || health.sleep === "behind") push(health.sleep === "at_risk" ? 3.5 : 4.5, "In bed by 12:30 AM tonight", `sleep goal is ${health.sleep === "at_risk" ? "at risk" : "behind"}`, { kind: "goal", key: "sleep" });
  if (health.weighin === "at_risk" || health.weighin === "behind" || health.weighin === "unknown") {
    const ist = new Date(now + 330 * 60000).getUTCHours();
    if (ist < 11 && !(lastWeighinDay && lastWeighinDay === day)) push(4, "Fasted weigh-in now (before eating)", "weekly weigh-in is due", { kind: "goal", key: "weighin" });
    else push(6, "Fasted weigh-in tomorrow morning", "weekly weigh-in is due", { kind: "goal", key: "weighin" });
  }
  // 6. What's coming up next on his schedule.
  anchors.filter(a => a.state === "upcoming").slice(0, 2).forEach((a, i) => push(7 + i, `${a.label} at ${a.time}`, "next on your schedule", { kind: "anchor", key: a.key, at: a.due }));

  // Risks for today.
  anchors.filter(a => a.state === "in extension").forEach(a => risks.push(`${a.label}: extension ends ${hm12(a.end)}`));
  Object.keys(health).filter(k => health[k] === "at_risk").forEach(k => risks.push(`${k} goal at risk this week`));
  if (recovery) risks.length = 0;

  // De-duplicate by key, best priority wins; top 3.
  const seen = new Set(), sorted = items.sort((a, b) => a.prio - b.prio).filter(it => { const k = it.key ? it.kind + ":" + it.key : it.title; if (seen.has(k) || seen.has("anchor:" + it.key) && it.kind === "repair") return false; seen.add(k); return true; });
  const top3 = recovery ? [{ prio: 0, title: "Recovery day — rest, water, sleep", why: "marked sick/injured: no training, no fines", kind: "recovery" }].concat(sorted.filter(i => i.kind === "promise" || i.kind === "log").slice(0, 2)) : sorted.slice(0, 3);
  return { day, top3, changes, risks, free: free.map(w => ({ from: hm12(w.from), to: hm12(w.to), min: Math.round((w.to - w.from) / 60000) })), message: recovery ? "Aaj recovery day hai — bas aaram." : changes.length ? "Plan update hua — din abhi bhi bacha hai." : null };
}

module.exports = { planToday, freeWindows, busyBlocks, hm12 };
