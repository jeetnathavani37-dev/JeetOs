// api/_context.js — the Shared Context Engine.
// Every coach call (chat via /api/ai and the cron pings in coach-nudge) gets
// the same structured "team context" packet, built here on the server from
// the shared jeetos_* rows. One source of truth instead of each caller
// stitching its own picture.
//
//   loadContextData(q, now)            → raw rows (q = path → array)
//   buildPacket(raw, { coach, purpose, now }) → { text, sections, unknowns, nextAction }
//
// Rules baked in:
//  - Missing data is "unknown", never a failure.
//  - Each coach sees only what its department needs (ACCESS below): money
//    only reaches Ronaldo (accountability) and Head; weight numbers don't go
//    to the appearance coaches or the mind coach.
//  - Old facts carry their date, so stale info isn't presented as current.
//  - Each purpose has a size budget; low-priority lines are trimmed first.
const { POLICY_V1, istAt, addDays, weightTrend, WEIGHT_RULES } = require("./_penalty");
const { visibleTo, label, KIND_LABEL } = require("./_memory");
const { graphHealth } = require("./_goals");

const SUPABASE_URL = "https://qzripzgbstvxkfobzhyv.supabase.co";
const PUBLIC_KEY = "sb_publishable_-EA-q_dacUuWovbrCW5XVw_pPZ2vK_O";

const COACH_IDS = ["skin", "hair", "fitness", "nutrition", "sleep", "style", "grooming", "ronaldo", "mind", "head"];
const COACH_NAMES = { skin: "Dr. Aria", hair: "Kai", fitness: "Marcus", nutrition: "Maya", sleep: "Dr. Sam", style: "Lex", grooming: "Blade", ronaldo: "Cristiano", mind: "Dr. Meher", head: "Head Coach" };
// Which coach owns which anchor of his day (same split as the anchor pings).
const ANCHOR_COACH = { wake: "sleep", gym: "fitness", breakfast: "nutrition", work: "ronaldo", lunch: "nutrition", snack: "nutrition", leave: "ronaldo", dinner: "nutrition", sleep: "sleep" };

// Department → data access. "all" = every coach; otherwise a list.
const ACCESS = {
  weight: ["fitness", "nutrition", "sleep", "ronaldo", "head"],
  money: ["ronaldo", "head"],
  disputes: ["ronaldo", "head"],
  team_promises: ["ronaldo", "head"],   // everyone else sees their own + a count
  all_goals: ["ronaldo", "head"],
};
const can = (coach, what) => (ACCESS[what] || []).includes(coach);

// Rough character budgets (≈ 4 chars per token).
const BUDGET = { chat: 9000, nudge: 5000, huddle: 12000 };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function istParts(now) {
  const d = new Date(now + 330 * 60000);
  return { date: d.toISOString().slice(0, 10), dow: d.getUTCDay(), h: d.getUTCHours(), m: d.getUTCMinutes(),
    label: `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` };
}
function hm12(mins) {
  const x = ((mins % 1440) + 1440) % 1440, h = Math.floor(x / 60), m = x % 60;
  return (h % 12 || 12) + ":" + String(m).padStart(2, "0") + (h < 12 ? " AM" : " PM");
}
function ago(day, today) {
  if (!day) return "date unknown";
  const n = Math.round((Date.parse(today) - Date.parse(String(day).slice(0, 10))) / 864e5);
  if (!isFinite(n)) return "date unknown";
  if (n <= 0) return "today";
  if (n === 1) return "yesterday";
  if (n < 14) return n + " days ago";
  if (n < 60) return Math.round(n / 7) + " weeks ago";
  return Math.round(n / 30) + " months ago";
}
// The schedule day: until 4 AM it's still last night's day (he may not have slept yet).
function planDay(now) {
  const p = istParts(now);
  return p.h < 4 ? addDays(p.date, -1) : p.date;
}

// ── Loading ────────────────────────────────────────────────────────────
// Server key first (owner-only tables need it after the lockdown); an old or
// rotated key answers 401, then fall back to the public key.
// With the owner's login token (a chat request) owner-only tables are readable
// even before the server key is configured.
function makeDb(env, ownerToken) {
  env = env || process.env;
  const svc = [env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_SECRET_KEY].filter(Boolean).map(k => k.trim());
  const auths = [...new Set(svc)].map(k => ({ apikey: k, Authorization: "Bearer " + k }));
  if (ownerToken) auths.push({ apikey: PUBLIC_KEY, Authorization: "Bearer " + ownerToken });
  [...new Set([env.SUPABASE_ANON_KEY, PUBLIC_KEY].filter(Boolean).map(k => k.trim()))].forEach(k => auths.push({ apikey: k, Authorization: "Bearer " + k }));
  return async function q(path) {
    try {
      let r;
      for (const h of auths) {
        r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: h });
        if (r.status !== 401) break;
      }
      if (!r.ok) return null;
      const d = await r.json();
      return Array.isArray(d) ? d : null;
    } catch (_) { return null; }   // null = couldn't read (not the same as "no rows")
  };
}

async function loadContextData(q, now) {
  now = now || Date.now();
  const day = planDay(now), week = addDays(day, -7), month = day.slice(0, 7);
  const since4 = new Date(now - 4 * 864e5).toISOString(), since7 = new Date(now - 7 * 864e5).toISOString();
  const keys = ["logs", "checkins", "marks", "openPromises", "closedPromises", "goals", "goalState", "weightGoal", "weighins", "memory", "profile", "notes", "inbox", "passes", "incidents", "disputes", "decisions", "memories", "graph"];
  const rows = await Promise.all([
    q(`jeetos_logs?day=gte.${week}&select=*&order=day.desc&limit=10`),
    q(`jeetos_anchor_checkins?day=gte.${week}&select=anchor,day,at,verified&limit=120`),
    q(`jeetos_streak_marks?date=gte.${week}&select=date,habit,kind,reason&order=date.desc&limit=50`),
    q("jeetos_commitments?status=eq.open&select=id,coach,text,due,owner,staked,deadline_at&order=due.asc&limit=40"),
    q(`jeetos_commitments?status=in.(done,missed)&resolved_at=gte.${encodeURIComponent(since7)}&select=coach,text,status,owner,blocker,resolved_at&order=resolved_at.desc&limit=20`),
    q("jeetos_coach_goals?status=eq.active&select=id,coach,text,unit,start_value,target,current_value,deadline,history,focus,created_at&order=created_at.desc&limit=40"),
    q("jeetos_goal_state?id=eq.jeet&select=data"),
    q("jeetos_weight_goals?status=in.(active,extension,review)&select=*&order=requested_at.desc&limit=1"),
    q(`jeetos_weighins?day=gte.${addDays(day, -28)}&select=id,day,kg,fasted,morning,measured_at,supersedes&order=day.desc&limit=80`),
    q("jeetos_team_memory?select=fact,from_coach,created_on&order=created_at.desc&limit=40"),
    q("jeetos_profile?id=eq.jeet&select=data,updated_at"),
    q(`jeetos_coach_notes?created_at=gte.${encodeURIComponent(since4)}&select=from_coach,to_coach,text,created_at&order=created_at.desc&limit=30`),
    q("jeetos_coach_inbox?select=coach,slot,text,created_on,created_at&order=created_at.desc&limit=30"),
    q(`jeetos_allowance_uses?month=eq.${month}&status=neq.released&select=category,day,kind`),
    q(`jeetos_penalty_incidents?updated_at=gte.${encodeURIComponent(since7)}&select=id,category,title,status,updated_at&order=updated_at.desc&limit=30`),
    q("jeetos_disputes?status=eq.open&select=id,incident_id,category&limit=10"),
    q("jeetos_decisions?status=eq.approved&select=coach,area,change,decided_at&order=decided_at.desc&limit=6"),
    q("jeetos_memories?status=in.(active,unconfirmed)&select=id,kind,text,scope,source_type,coach,confidence,status,pending,observed_at,review_after&order=observed_at.desc&limit=80"),
    q("jeetos_goals?status=eq.active&select=id,kind,parent_id,title,owner_coach,metric,target,status,approved_at"),
  ]);
  const raw = { failed: [] };
  keys.forEach((k, i) => { if (!Array.isArray(rows[i])) raw.failed.push(k); raw[k] = Array.isArray(rows[i]) ? rows[i] : []; });
  raw.goalState = raw.goalState[0] ? raw.goalState[0].data : null;
  raw.weightGoal = raw.weightGoal[0] || null;
  raw.profile = raw.profile[0] || null;
  return raw;
}

// ── Pure helpers ───────────────────────────────────────────────────────
// Status of every anchor on the plan day: done / upcoming / in extension / not checked in.
function anchorStatus(raw, now) {
  const day = planDay(now);
  const log = (raw.logs || []).find(l => String(l.day).slice(0, 10) === day) || null;
  const seen = (log && log.entries_seen) || {};
  const list = POLICY_V1.anchors.list, out = [];
  const dow = new Date(day + "T12:00:00Z").getUTCDay();
  for (const key of Object.keys(list)) {
    const A = list[key];
    if (A.days && !A.days.includes(dow)) continue;
    const due = istAt(A.next_day ? addDays(day, 1) : day, A.time), end = due + A.ext_min * 60000;
    const done = A.kind === "meal" ? !!seen[key] : (raw.checkins || []).some(c => c.anchor === key && String(c.day).slice(0, 10) === day);
    const [h, m] = A.time.split(":").map(Number);
    let state;
    if (done) state = "done";
    else if (now < due) state = "upcoming";
    else if (now <= end) state = "in extension";
    else state = "not checked in";
    out.push({ key, label: A.label, time: hm12(h * 60 + m), due, end, state, coach: ANCHOR_COACH[key] });
  }
  return out;
}

const shown = (v, u) => (v == null ? "not logged" : v + u);
function logText(log) {
  if (!log) return "nothing logged yet";
  return `gym ${log.gym_done ? "done" : "not logged"}, sleep ${shown(log.sleep_hours, "h")}${log.bedtime ? ` (bed ${log.bedtime})` : ""}, protein ${shown(log.total_protein, "g")}, calories ${shown(log.total_cal, " kcal")}, junk meals ${shown(log.junk_meals, "")}, water ${shown(log.water, " glasses")}, mood ${shown(log.mood, "/5")}, energy ${shown(log.energy, "/5")}`;
}

function goalLine(g, today) {
  const u = g.unit ? " " + g.unit : "";
  let s = `"${g.text}" (${COACH_NAMES[g.coach] || g.coach})`;
  if (g.target != null) s += `: start ${g.start_value}${u} → now ${g.current_value == null ? "unknown" : g.current_value + u} → target ${g.target}${u}`;
  if (g.deadline) s += `, by ${g.deadline}`;
  const last = (g.history || []).slice(-1)[0];
  if (last) s += `, last update ${ago(last.d, today)}`;
  const pace = goalPace(g, today);
  if (pace) s += `, ${pace}`;
  return s;
}
// Linear pace check: where should he be by now? Unknown if there isn't enough to judge.
function goalPace(g, today) {
  if (g.target == null || g.start_value == null || g.current_value == null || !g.deadline) return null;
  const start = String(g.created_at || "").slice(0, 10);
  if (!start) return null;
  const total = Date.parse(g.deadline) - Date.parse(start), done = Date.parse(today) - Date.parse(start);
  if (!(total > 0) || done < 0) return null;
  const expected = +g.start_value + (+g.target - +g.start_value) * Math.min(1, done / total);
  const ahead = (+g.target >= +g.start_value) ? +g.current_value >= expected : +g.current_value <= expected;
  return ahead ? "on track" : `behind (expected ~${Math.round(expected * 10) / 10} by now)`;
}

function weightSummary(raw, today) {
  const g = raw.weightGoal;
  const w = raw.weighins || [];
  const trend = weightTrend(w, today, WEIGHT_RULES);
  const latest = w.slice().sort((a, b) => String(b.day).localeCompare(String(a.day)))[0];
  const parts = [];
  if (g && g.baseline_kg != null) {
    const target = Math.round((+g.baseline_kg - +g.target_loss_kg) * 10) / 10;
    parts.push(`baseline ${+g.baseline_kg} kg → target ${target} kg by ${g.end_day}${g.ext_end_day ? ` (extension to ${g.ext_end_day})` : ""}, status ${g.status}`);
    if (trend.cur != null) {
      const lost = Math.round((+g.baseline_kg - trend.cur) * 10) / 10;
      const span = Date.parse(g.end_day) - Date.parse(g.start_day || g.baseline_day), el = Date.parse(today) - Date.parse(g.start_day || g.baseline_day);
      const expected = span > 0 && el > 0 ? Math.round(+g.target_loss_kg * Math.min(1, el / span) * 10) / 10 : null;
      parts.push(`7-day mean ${trend.cur} kg (lost ${lost} kg${expected != null ? `, plan expects ~${expected} kg by now → ${lost >= expected ? "on track" : "behind"}` : ""})`);
    }
  } else if (g) parts.push(`goal requested, baseline not set yet (needs 3 fasted morning weigh-ins)`);
  if (trend.pct_week != null) parts.push(`week-on-week ${trend.pct_week}%${trend.fast ? " — FASTER than safe (>1%/week), check he's eating enough" : ""}`);
  if (latest) parts.push(`last weigh-in ${+latest.kg} kg ${ago(latest.day, today)}`);
  else parts.push("no weigh-ins in the last 4 weeks (unknown)");
  return parts.join("; ");
}

// What should he do next? Deterministic, in priority order.
function nextAction(raw, anchors, now, today) {
  const ext = anchors.find(a => a.state === "in extension");
  if (ext) return `"${ext.label}" is in its extension window until ${hm12(Math.round(((ext.end + 330 * 60000) % 864e5) / 60000))} — do it and check in now (uses 1 pass, ₹100 after).`;
  const dueP = (raw.openPromises || []).filter(c => c.owner !== "coach" && c.due && c.due <= today);
  if (dueP.length) return `Promise due ${dueP[0].due <= addDays(today, -1) ? "and overdue" : "today"}: "${dueP[0].text}" (${COACH_NAMES[dueP[0].coach] || dueP[0].coach}).`;
  const soon = anchors.find(a => a.state === "upcoming" && a.due - now <= 90 * 60000);
  if (soon) return `Next up: "${soon.label}" at ${soon.time}.`;
  const gs = raw.goalState;
  if (gs && gs.today && gs.today.date === today && !gs.today.done) return `Today's priority still open: "${gs.today.text}".`;
  const p = istParts(now);
  const log = (raw.logs || []).find(l => String(l.day).slice(0, 10) === today);
  if (p.h >= 9 && p.h < 14 && (!log || log.sleep_hours == null)) return "Log last night's sleep (hours + bedtime).";
  const later = anchors.find(a => a.state === "upcoming");
  if (later) return `Nothing urgent. Next anchor: "${later.label}" at ${later.time}.`;
  return "Nothing urgent right now.";
}

// ── Packet ─────────────────────────────────────────────────────────────
function buildPacket(raw, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const coach = COACH_IDS.includes(opts.coach) ? opts.coach : "head";
  const purpose = BUDGET[opts.purpose] ? opts.purpose : "chat";
  const P = istParts(now), today = planDay(now);
  const sections = [], unknowns = [];
  const add = (key, title, lines, prio) => { lines = lines.filter(Boolean); if (lines.length) sections.push({ key, title, lines, prio }); };

  add("now", "NOW", [`${P.label}, ${hm12(P.h * 60 + P.m)} IST${today !== P.date ? ` (still counts as ${today} — he may not have slept yet)` : ""}`], 0);

  // Primary goal + department goals.
  const goals = raw.goals || [];
  const gs = raw.goalState;
  const primary = gs && gs.goalId ? goals.find(g => g.id === gs.goalId) : null;
  const pLines = [];
  const graph = (raw.graph || []).length ? graphHealth(raw.graph, raw, today) : null;
  const ST = { on_track: "ON TRACK", behind: "BEHIND", at_risk: "AT RISK", unknown: "UNKNOWN (not enough data)" };
  if (graph && graph.primary) {
    const gp = graph.primary;
    pLines.push(`${gp.title} — ${ST[gp.state]}${can(coach, "weight") || coach === "head" ? `: ${gp.detail}` : ""}`);
    (gp.flags || []).forEach(f => pLines.push(`⚑ ${f}${gp.needs_review ? " → plan may need adjustment; Head Coach proposes, Jeet approves (never change targets yourself)" : ""}`));
    graph.goals.filter(g => g.parent_id === gp.id).forEach(g => pLines.push(`supporting${g.owner_coach === coach ? " (YOURS)" : ""}: ${g.title} [${COACH_NAMES[g.owner_coach] || g.owner_coach}] — ${ST[g.state]}: ${g.detail}`));
  } else if (primary) pLines.push(goalLine(primary, today));
  else if (raw.weightGoal) pLines.push("Weight goal (the ledger's 10 kg plan) — no other primary goal is set.");
  else pLines.push("No primary goal set yet (unknown) — don't invent one; ask Head Coach / Jeet to set it.");
  if (gs && gs.today && gs.today.date === today) pLines.push(`Today's one priority: "${gs.today.text}" — ${gs.today.done ? "done" : "not done yet"}.`);
  if (can(coach, "weight") && (raw.weightGoal || (raw.weighins || []).length)) pLines.push("Weight: " + weightSummary(raw, today));
  add("primary", "PRIMARY GOAL", pLines, 1);

  const mine = goals.filter(g => g.coach === coach && (!primary || g.id !== primary.id));
  const others = goals.filter(g => g.coach !== coach && (!primary || g.id !== primary.id));
  const gLines = mine.map(g => "yours: " + goalLine(g, today));
  if (can(coach, "all_goals")) others.forEach(g => gLines.push(goalLine(g, today)));
  else if (others.length) gLines.push(`teammates have ${others.length} other active goal${others.length > 1 ? "s" : ""} (${[...new Set(others.map(g => COACH_NAMES[g.coach] || g.coach))].join(", ")})`);
  add("goals", "DEPARTMENT GOALS", gLines.length ? gLines : ["none active"], 5);

  // Today: anchors + log.
  const anchors = anchorStatus(raw, now);
  const log = (raw.logs || []).find(l => String(l.day).slice(0, 10) === today) || null;
  const aLines = anchors.map(a => `${a.time} ${a.label}: ${a.state}${a.coach === coach ? " (your area)" : ""}`);
  aLines.push("Log today: " + logText(log));
  add("today", "TODAY'S SCHEDULE & LOG (\"not checked in\" = no check-in recorded, not proof he skipped it)", aLines, 2);
  anchors.filter(a => a.state === "not checked in").forEach(a => unknowns.push(`${a.label} (${a.time}) — no check-in`));
  if (!log) unknowns.push("today's log — nothing entered yet");
  else ["sleep_hours", "total_protein", "total_cal", "mood"].forEach(k => { if (log[k] == null) unknowns.push(k.replace("total_", "").replace("_hours", "") + " not logged"); });

  // Promises.
  const open = raw.openPromises || [];
  const his = open.filter(c => c.owner !== "coach");
  const visible = can(coach, "team_promises") ? his : his.filter(c => c.coach === coach);
  const prLines = visible.map(c => `"${c.text}" — ${COACH_NAMES[c.coach] || c.coach}, check on ${c.due}${c.due && c.due < today ? " (OVERDUE)" : ""}${c.staked ? " [staked]" : ""}`);
  if (!can(coach, "team_promises") && his.length > visible.length) prLines.push(`+${his.length - visible.length} open promise(s) with teammates`);
  const coachOwes = open.filter(c => c.owner === "coach" && c.coach === coach);
  coachOwes.forEach(c => prLines.push(`YOU promised him: "${c.text}" by ${c.due}`));
  const closed = (raw.closedPromises || []).filter(c => can(coach, "team_promises") || c.coach === coach).slice(0, 5);
  closed.forEach(c => prLines.push(`recent outcome: "${c.text}" → ${c.status}${c.blocker ? ` (blocker: ${c.blocker})` : ""}, ${ago(String(c.resolved_at).slice(0, 10), today)}`));
  add("promises", "PROMISES (open + last 7 days' outcomes)", prLines.length ? prLines : ["no open promises"], 3);

  // Exceptions: sick/recovery marks, rest days, passes.
  const exLines = [];
  const marks = raw.marks || [];
  const rec = marks.filter(m => m.kind === "recovery");
  if (rec.length) exLines.push(`recovery (sick/injury) days this week: ${[...new Set(rec.map(m => m.date))].join(", ")}${rec.some(m => m.date === today) ? " — TODAY is a recovery day: don't push training or penalties" : ""}`);
  const mins = marks.filter(m => m.kind === "min" && m.date === today);
  if (mins.length) exLines.push(`minimum-version marked today for: ${mins.map(m => m.habit).join(", ")}`);
  const passes = raw.passes || [];
  if (passes.length) {
    const by = {};
    passes.forEach(x => { by[x.category] = (by[x.category] || 0) + 1; });
    const lim = Object.assign({}, ...Object.keys(POLICY_V1.exceptions || {}).map(k => ({ [k]: POLICY_V1.exceptions[k].monthly_allowance })));
    exLines.push("passes used this month: " + Object.keys(by).map(k => k.startsWith("a_") ? `${k.slice(2)} ${by[k]}/${POLICY_V1.anchors.passes}` : `${k} ${by[k]}${lim[k] ? "/" + lim[k] : ""}`).join(", "));
  }
  add("exceptions", "EXCEPTIONS", exLines, 4);

  // Money (accountability only).
  if (can(coach, "money")) {
    const inc = raw.incidents || [];
    const mLines = inc.slice(0, 8).map(i => `${i.title || i.category}: ${i.status} (${ago(String(i.updated_at).slice(0, 10), today)})`);
    if (can(coach, "disputes") && (raw.disputes || []).length) mLines.push(`${raw.disputes.length} dispute(s) open — fines paused until decided`);
    add("ledger", "LEDGER (last 7 days)", mLines.length ? mLines : ["no incidents this week"], 6);
  }

  // Team notes to this coach, and approved plan decisions.
  const notes = (raw.notes || []).filter(n => (n.to_coach === coach || n.to_coach === "team") && n.from_coach !== coach).slice(0, 5);
  add("notes", "TEAMMATES TOLD YOU (last 4 days)", notes.map(n => `${COACH_NAMES[n.from_coach] || n.from_coach}: ${n.text}`), 7);
  const dec = (raw.decisions || []).slice(0, 4);
  add("plan", "APPROVED PLAN DECISIONS", dec.map(d => `${d.area || ""}: ${d.change} (${COACH_NAMES[d.coach] || d.coach}, ${ago(String(d.decided_at).slice(0, 10), today)})`), 8);

  // Last intervention from this coach and whether it landed.
  const last = (raw.inbox || []).find(x => x.coach === coach || coach === "head");
  if (last) {
    let worked = "";
    const ak = /^a_(\w+)$/.exec(last.slot || "");
    if (ak && last.created_on === today) {
      const a = anchors.find(x => x.key === ak[1]);
      if (a) worked = ` → ${a.label} is now: ${a.state}`;
    }
    add("last", "LAST PING", [`(${ago(last.created_on, today)}, ${last.slot}) "${String(last.text).slice(0, 200)}"${worked}`], 9);
  }

  // Memory: newest first, each with its date, source and confidence. Memory v2
  // (jeetos_memories) when it has rows; the older team memory + profile otherwise.
  const memLines = [];
  const mems = (raw.memories || []).filter(m => visibleTo(m, coach));
  if ((raw.memories || []).length) {
    mems.forEach(m => memLines.push(`[${KIND_LABEL[m.kind] || m.kind}] ${m.text} (${ago(String(m.observed_at).slice(0, 10), today)}; ${label(m, today)}${m.scope === "private:mind" ? "; PRIVATE to you" : ""})`));
  } else {
    const prof = raw.profile && raw.profile.data;
    if (prof) {
      for (const sec of ["goals", "routine", "struggles", "preferences", "style", "about", "life", "wins"]) {
        (Array.isArray(prof[sec]) ? prof[sec] : []).slice(-6).forEach(x => memLines.push(`[${sec}] ${x.t} (${x.d ? ago(x.d, today) : "date unknown"}${x.src ? ", from " + x.src : ""})`));
      }
    }
    (raw.memory || []).forEach(m => memLines.push(`${m.fact} (${ago(m.created_on, today)}, noted by ${COACH_NAMES[m.from_coach] || m.from_coach || "team"})`));
  }
  add("memory", "WHAT THE TEAM KNOWS (dated; older or unconfirmed items — confirm before relying on them)", memLines, 10);

  // Unknowns + next action.
  const na = nextAction(raw, anchors, now, today);
  add("unknowns", "UNKNOWN / MISSING (ask, don't assume)", unknowns.length ? unknowns.slice(0, 10) : ["nothing important missing"], 3);
  add("next", "NEXT ACTION", [na], 1);

  const failed = raw.failed || [];
  const header = `=== TEAM CONTEXT for ${COACH_NAMES[coach]} (built by the server; every coach sees the same facts). "unknown"/"not logged"/"no check-in" means NO DATA — never treat it as failure. ===`
    + (failed.length ? `\n!! The server couldn't read part of his data right now (${failed.join(", ")}). Treat those parts as UNKNOWN, not empty — don't tell him he has no goals/promises/logs.` : "");
  const text = render(header, sections, BUDGET[purpose]);
  return { coach, purpose, day: today, text, failed, graph: graph ? graph.goals.map(g => ({ id: g.id, state: g.state })) : null, sections, unknowns, nextAction: na, anchors: anchors.map(a => ({ key: a.key, state: a.state })) };
}

// Fit the packet into the budget: trim the lowest-priority sections' tails
// first, then drop whole sections. NOW / PRIMARY / NEXT are never dropped.
function render(header, sections, budget) {
  const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const sorted = sections.slice().sort((a, b) => order.indexOf(a.prio) - order.indexOf(b.prio));
  const fmt = list => header + "\n" + list.map(s => `[${s.title}]\n` + s.lines.map(l => "- " + l).join("\n")).join("\n");
  let list = sorted.map(s => Object.assign({}, s, { lines: s.lines.slice() }));
  let out = fmt(list);
  while (out.length > budget) {
    const victim = list.slice().reverse().find(s => s.prio > 1 && s.lines.length > 1);
    if (victim) { victim.lines.pop(); }
    else {
      const drop = list.slice().reverse().find(s => s.prio > 1);
      if (!drop) break;
      list = list.filter(s => s !== drop);
    }
    out = fmt(list);
  }
  return out;
}

async function contextFor(opts, deps) {
  deps = deps || {};
  const now = opts.now || Date.now();
  const raw = await loadContextData(deps.q || makeDb(process.env, deps.ownerToken), now);
  return buildPacket(raw, Object.assign({}, opts, { now }));
}

module.exports = { buildPacket, loadContextData, contextFor, makeDb, anchorStatus, planDay, nextAction, ACCESS, BUDGET, COACH_IDS };
