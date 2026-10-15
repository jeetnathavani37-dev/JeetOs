// api/_penalty.js — the penalty rules engine (deterministic, no AI).
// Pure functions: given the active policy, commitments, log rows and the
// entries already in the ledger, it returns what should be added. The cron /
// api/penalty.js write the result; unique keys in the DB make re-runs no-ops.
// Money is integer paise. Dates are Asia/Kolkata (India has no DST).

const POLICY_V1 = {
  version: 1,
  mode: "simulation",
  tz: "Asia/Kolkata",
  promise: {
    base_paise: 25000,          // ₹250 for the first overdue day
    escalation: "double",       // day n = base × 2^(n-1)
    grace_min: 120,             // 2 h after the deadline before day 1 counts
    max_days: 3,                // days 1-3 (₹250 + ₹500 + ₹1,000), then review
    honest_close_stops: true,   // marking it "missed" yourself stops the doubling
  },
  log: {
    amount_paise: 10000,        // ₹100 per missing required entry
    grace_min: 120,
    entries: {
      breakfast: { deadline: "11:00", label: "Breakfast log" },
      lunch: { deadline: "16:00", label: "Lunch log" },
      dinner: { deadline: "22:00", label: "Dinner log" },
      sleep: { deadline: "12:00", label: "Sleep log (last night)" },
    },
  },
  // Monthly passes (IST calendar month, no rollover). A miss first uses a pass; only
  // when the month's passes are gone does it cost money (once — no doubling).
  // A "recovery" mark (ill / injured / real recovery need) excuses it without a pass.
  exceptions: {
    gym: { label: "Gym day missed", days: [1, 2, 3, 4, 5, 6], deadline: "23:59", grace_min: 120, monthly_allowance: 7, after_paise: 25000, habit: "move" },
    diet: { label: "Diet exception", deadline: "23:59", grace_min: 120, monthly_allowance: 4, after_paise: 10000, cal_limit: 2100, habit: "food" },
    sleep: { label: "Sleep exception", deadline: "12:00", grace_min: 120, monthly_allowance: 4, after_paise: 10000, min_hours: 6, latest_bed: "00:30", habit: "sleep" },
    recovery_review_after: 3,   // more than 3 recovery days in 7 → review (and a doctor nudge), not auto-excused
  },
  caps: { incident_paise: 175000, day_paise: 100000, month_paise: 500000 },
  overlap: "suppress",          // one underlying omission → one fine
};

const IST_MIN = 330;
const istDate = t => new Date(new Date(t).getTime() + IST_MIN * 60000).toISOString().slice(0, 10);
const istAt = (date, hm) => new Date(`${date}T${hm}:00+05:30`).getTime();
const addDays = (date, n) => new Date(Date.parse(date + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const rupees = p => "₹" + (p / 100).toLocaleString("en-IN");

// Checkpoints for a staked promise: day n is judged at deadline + grace + (n-1) days.
function promiseDue(c, policy, now) {
  const P = policy.promise;
  if (!c.staked || !c.agreed_at || !c.deadline_at) return { eligible: false, why: "not staked" };
  const deadline = Date.parse(c.deadline_at), agreed = Date.parse(c.agreed_at);
  if (!(agreed < deadline)) return { eligible: false, why: "agreed after the deadline" };
  if (policy.effective_from && agreed < Date.parse(policy.effective_from)) return { eligible: false, why: "agreed before this policy" };
  const done = c.done_at ? Date.parse(c.done_at) : null;
  const closed = c.status !== "open" && c.resolved_at ? Date.parse(c.resolved_at) : null;
  const out = [];
  for (let n = 1; n <= P.max_days; n++) {
    const cp = deadline + P.grace_min * 60000 + (n - 1) * 864e5;
    if (cp > now) break;
    if (done != null && done <= cp) break;                       // completed in time for this checkpoint
    if (n > 1 && P.honest_close_stops && closed != null && closed <= cp) break; // he closed it → no more doubling
    if (c.status === "excused" || c.status === "disputed") break;
    out.push({ n, checkpoint: cp, local_date: istDate(cp), raw: P.base_paise * Math.pow(2, n - 1) });
  }
  return { eligible: true, days: out, reachedMax: out.length === P.max_days };
}

// A required log entry: missing if the server first saw it after deadline + grace.
// If the phone recorded it in time but synced late, it goes to review instead of a fine.
function logStatus(key, date, row, policy, now) {
  const L = policy.log, e = L.entries[key];
  const cp = istAt(date, e.deadline) + L.grace_min * 60000;
  if (cp > now) return { state: "pending", checkpoint: cp };
  const seen = row && row.entries_seen && row.entries_seen[key] ? Date.parse(row.entries_seen[key]) : null;
  const client = row && row.entries && row.entries[key] ? Date.parse(row.entries[key]) : null;
  if (seen != null && seen <= cp) return { state: "ok", checkpoint: cp };
  if (client != null && client <= cp) return { state: "review", checkpoint: cp, why: "logged on the phone in time, synced late" };
  return { state: "missing", checkpoint: cp, lateBy: seen != null ? seen - cp : null };
}

// "11:30 PM", "1 am", "00:45", "1:15" → minutes after midnight (null if unreadable).
function bedMinutes(t) {
  const m = /^\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*$/i.exec(String(t || ""));
  if (!m) return null;
  let h = +m[1] % 24; const min = +(m[2] || 0), ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h * 60 + min;
}
// Gym / diet / sleep exceptions per day. State: ok | pending | excused | review | covered | needs_allowance.
// Missing data is never a violation here (missing logs are the log rules' job).
function exceptionCandidates({ policy, logs, marks, uses, now }) {
  const X = policy.exceptions;
  if (!X) return [];
  const from = policy.effective_from ? istDate(policy.effective_from) : istDate(now);
  const markOf = (date, habit) => (marks || []).find(m => String(m.date).slice(0, 10) === date && m.habit === habit) || null;
  const recoveryDays = date => new Set((marks || []).filter(m => m.kind === "recovery" && String(m.date) <= date && String(m.date) > addDays(date, -7)).map(m => String(m.date).slice(0, 10))).size;
  const used = (cat, date) => (uses || []).find(u => u.category === cat && String(u.day) === date && u.status === "used") || null;
  const out = [];
  for (let date = from; date <= istDate(now); date = addDays(date, 1)) {
    const row = (logs || []).find(r => r.day === date || r.date === date) || null;
    const weekday = new Date(date + "T12:00:00Z").getUTCDay();
    for (const cat of ["gym", "diet", "sleep"]) {
      const R = X[cat];
      if (cat === "gym" && !R.days.includes(weekday)) continue;
      const deadline = istAt(date, R.deadline), cp = deadline + R.grace_min * 60000;
      if (policy.effective_from && deadline <= Date.parse(policy.effective_from)) continue;
      const base = { category: cat, date, checkpoint: cp, root_key: cat + ":" + date, label: R.label };
      if (cp > now) { out.push(Object.assign(base, { state: "pending" })); continue; }
      let bad = false, why = "", review = false;
      if (cat === "gym") {
        const seen = row && row.entries_seen && row.entries_seen.workout ? Date.parse(row.entries_seen.workout) : null;
        const client = row && row.entries && row.entries.workout ? Date.parse(row.entries.workout) : null;
        if (seen != null && seen <= cp) bad = false;
        else if (client != null && client <= cp) { review = true; why = "workout logged on the phone in time, synced late"; }
        else if (seen == null && row && row.gym_done) bad = false;
        else { bad = true; why = seen != null ? "workout logged after the day ended" : "no workout logged on a " + ["", "Push", "Pull", "Legs", "Push", "Pull", "Legs"][weekday] + " day"; }
        const mk = markOf(date, R.habit);
        if (bad && mk && mk.kind === "min") { bad = false; why = ""; }      // the agreed minimum (20 min home workout / 30 min walk)
      } else if (cat === "diet") {
        const junk = row ? +row.junk_meals || 0 : 0, cal = row && row.total_cal != null ? +row.total_cal : null;
        if (junk > 0) { bad = true; why = junk + " junk meal" + (junk > 1 ? "s" : "") + " logged"; }
        else if (cal != null && cal > R.cal_limit) { bad = true; why = cal + " kcal logged (limit " + R.cal_limit + ")"; }
      } else {
        const hrs = row && row.sleep_hours != null ? +row.sleep_hours : null, bed = bedMinutes(row && row.bedtime);
        const latest = bedMinutes(R.latest_bed);
        if (hrs != null && hrs < R.min_hours) { bad = true; why = hrs + "h sleep logged (minimum " + R.min_hours + "h)"; }
        else if (bed != null && bed > latest && bed < 6 * 60) { bad = true; why = "bedtime " + row.bedtime + " logged (after " + R.latest_bed + " AM)"; }
      }
      if (review) { out.push(Object.assign(base, { state: "review", why })); continue; }
      if (!bad) { out.push(Object.assign(base, { state: "ok" })); continue; }
      const mk = markOf(date, R.habit);
      if (mk && mk.kind === "recovery") {
        const n = recoveryDays(date);
        out.push(Object.assign(base, n > X.recovery_review_after
          ? { state: "review", why: why + " — " + n + " recovery days in a week, needs a real review (see a doctor if unwell)" }
          : { state: "excused", why: why + " — recovery day" + (mk.reason ? " (" + mk.reason + ")" : "") }));
        continue;
      }
      const u = used(cat, date);
      if (u) { out.push(Object.assign(base, { state: "covered", why: why + " — " + (u.kind === "planned" ? "planned rest day" : "monthly pass used") })); continue; }
      out.push(Object.assign(base, { state: "needs_allowance", why }));
    }
  }
  return out;
}

// Trims an amount to the remaining incident / day / month allowance.
function capTrim(raw, sums, caps) {
  const room = Math.min(caps.incident_paise - sums.incident, caps.day_paise - sums.day, caps.month_paise - sums.month);
  return Math.max(0, Math.min(raw, room));
}

// Everything the ledger should contain now. `entries` = existing ledger rows.
// `extra` = already-decided exception incidents ({ incident, want? }) that share the cap logic.
function plan({ policy, commitments, logs, entries, incidents, now, extra }) {
  const ver = policy.version, caps = policy.caps;
  const have = new Set(entries.map(e => e.incident_id + "|" + e.kind + "|" + e.local_date));
  const net = (f) => entries.filter(f).reduce((a, e) => a + Number(e.amount_paise), 0);
  const added = [];
  const sumFor = (f) => net(f) + added.filter(f).reduce((a, e) => a + e.amount_paise, 0);
  const incOut = new Map();
  const knownRoots = new Map((incidents || []).filter(i => i.status !== "overlap_suppressed").map(i => [i.root_key, i.id]));
  const want = [];

  for (const c of commitments || []) {
    const d = promiseDue(c, policy, now);
    if (!d.eligible || !d.days.length) continue;
    const id = "promise:" + c.id;
    incOut.set(id, { id, source_key: id, commitment_id: c.id, category: "promise", root_key: "promise:" + c.id, policy_version: ver,
      title: c.text, status: d.reachedMax ? "review" : (c.status === "open" ? "escalating" : "resolved"), overlap_of: null,
      detail: { deadline_at: c.deadline_at, agreed_at: c.agreed_at, coach: c.coach } });
    d.days.forEach(x => want.push({ incident_id: id, kind: x.n === 1 ? "assessment" : "escalation", day_n: x.n, local_date: x.local_date, raw: x.raw, checkpoint: x.checkpoint,
      why: x.n === 1 ? `Not done by the deadline + ${policy.promise.grace_min / 60}h grace` : `Still open on overdue day ${x.n} — ₹250 × 2^${x.n - 1}` }));
  }

  const from = policy.effective_from ? istDate(policy.effective_from) : istDate(now);
  for (let date = from; date <= istDate(now); date = addDays(date, 1)) {
    const row = (logs || []).find(r => r.day === date || r.date === date) || null;
    for (const key of Object.keys(policy.log.entries)) {
      const st = logStatus(key, date, row, policy, now);
      if (st.state === "pending" || st.state === "ok") continue;
      if (policy.effective_from && st.checkpoint - policy.log.grace_min * 60000 <= Date.parse(policy.effective_from)) continue; // deadline before the policy started
      const id = "log:" + key + ":" + date, root = "log:" + key + ":" + date;
      const other = knownRoots.get(root);
      const overlap = other && other !== id;
      incOut.set(id, { id, source_key: id, commitment_id: null, category: "log", root_key: root, policy_version: ver,
        title: policy.log.entries[key].label + " — " + date, status: overlap ? "overlap_suppressed" : st.state === "review" ? "review" : "resolved", overlap_of: overlap ? other : null,
        detail: { entry: key, date, why: st.why || null, late_by_min: st.lateBy != null ? Math.round(st.lateBy / 60000) : null } });
      if (st.state === "missing" && !overlap) want.push({ incident_id: id, kind: "assessment", day_n: 1, local_date: date, raw: policy.log.amount_paise, checkpoint: st.checkpoint,
        why: st.lateBy != null ? `Logged ${Math.round(st.lateBy / 60000)} min after the grace deadline` : "Not logged by the grace deadline" });
    }
  }

  for (const x of extra || []) { incOut.set(x.incident.id, x.incident); if (x.want) want.push(x.want); }
  want.sort((a, b) => a.checkpoint - b.checkpoint);
  for (const w of want) {
    if (have.has(w.incident_id + "|" + w.kind + "|" + w.local_date)) continue;
    const month = w.local_date.slice(0, 7);
    const sums = {
      incident: sumFor(e => e.incident_id === w.incident_id),
      day: sumFor(e => String(e.local_date) === w.local_date),
      month: sumFor(e => String(e.local_date).slice(0, 7) === month),
    };
    const amount = capTrim(w.raw, sums, caps);
    const inc = incOut.get(w.incident_id);
    if (amount < w.raw) inc.status = "capped";
    if (amount <= 0) continue;
    added.push({ incident_id: w.incident_id, kind: w.kind, day_n: w.day_n, local_date: w.local_date, amount_paise: amount, policy_version: ver, created_by: "engine",
      calc: { formula: w.kind === "escalation" || w.day_n > 1 ? "base × 2^(n-1)" : inc.category === "log" ? "flat per missing entry" : inc.category === "promise" ? "base" : "flat, after the month's passes ran out", raw_paise: w.raw, trimmed_by_cap: amount < w.raw,
        sums_before: sums, caps, checkpoint: new Date(w.checkpoint).toISOString(), why: w.why, mode: policy.mode } });
  }
  // An incident that has used its whole per-incident cap stays capped.
  for (const inc of incOut.values()) if (inc.category === "promise" && sumFor(e => e.incident_id === inc.id) >= caps.incident_paise) inc.status = "capped";
  return { incidents: [...incOut.values()], entries: added };
}

// Turns exception candidates (after allowance decisions) into incidents + wants for plan().
// decided[i] = { allowance: { ok } } for needs_allowance items.
function exceptionExtras(policy, cands, decided) {
  const X = policy.exceptions, out = [];
  cands.forEach((c, i) => {
    if (c.state === "ok" || c.state === "pending") return;
    const id = c.category + ":" + c.date;
    const inc = { id, source_key: id, commitment_id: null, category: c.category, root_key: c.root_key, policy_version: policy.version, title: c.label + " — " + c.date, overlap_of: null, detail: { date: c.date, why: c.why || null } };
    if (c.state === "excused") inc.status = "excused";
    else if (c.state === "review") inc.status = "review";
    else if (c.state === "covered") inc.status = "allowance";
    else {
      const a = decided && decided[i] && decided[i].allowance;
      if (a && a.ok) { inc.status = "allowance"; inc.detail.pass = (a.used || "?") + "/" + X[c.category].monthly_allowance; }
      else if (a) {
        inc.status = "resolved";
        out.push({ incident: inc, want: { incident_id: id, kind: "assessment", day_n: 1, local_date: c.date, raw: X[c.category].after_paise, checkpoint: c.checkpoint,
          why: c.why + " — all " + X[c.category].monthly_allowance + " passes used this month" } });
        return;
      } else return; // no decision yet → nothing written
    }
    out.push({ incident: inc });
  });
  return out;
}

module.exports = { POLICY_V1, plan, promiseDue, logStatus, capTrim, istDate, istAt, addDays, rupees, exceptionCandidates, exceptionExtras, bedMinutes };
