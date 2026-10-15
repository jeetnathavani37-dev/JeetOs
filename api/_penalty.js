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
      sleep: { deadline: "12:00", label: "Sleep log (last night)" },   // meals are timed anchors now
    },
  },
  // Monthly passes (IST calendar month, no rollover). A miss first uses a pass; only
  // when the month's passes are gone does it cost money (once — no doubling).
  // A "recovery" mark (ill / injured / real recovery need) excuses it without a pass.
  exceptions: {
    gym: { label: "Gym day missed", days: [1, 2, 3, 4, 5, 6], deadline: "23:59", grace_min: 120, monthly_allowance: 7, after_paise: 25000, habit: "move" },
    diet: { label: "Diet exception", deadline: "23:59", grace_min: 120, monthly_allowance: 4, after_paise: 10000, cal_limit: 2100, habit: "food" },
    sleep: { label: "Sleep exception", deadline: "12:00", grace_min: 120, monthly_allowance: 4, after_paise: 10000, min_hours: 6, latest_bed: null, habit: "sleep" }, // bedtime is the "sleep" anchor
    recovery_review_after: 3,   // more than 3 recovery days in 7 → review (and a doctor nudge), not auto-excused
  },
  // His day, as he set it. On time = no cost. Inside the extension window = one of that anchor's
  // 5 monthly passes. After the window, or with no passes left = ₹100. A recovery (sick) mark
  // excuses the whole day. Meals are checked from the meal log's server time; the rest from check-ins.
  anchors: {
    passes: 5, after_paise: 10000,
    list: {
      wake: { label: "Wake up", time: "08:00", ext_min: 60, kind: "checkin" },
      gym: { label: "Gym reporting", time: "09:30", ext_min: 30, kind: "checkin", place: "gym", days: [1, 2, 3, 4, 5, 6] },
      breakfast: { label: "Breakfast", time: "11:30", ext_min: 30, kind: "meal" },
      work: { label: "Library / work", time: "12:30", ext_min: 30, kind: "checkin", place: "work", days: [1, 2, 3, 4, 5, 6] },
      lunch: { label: "Lunch", time: "15:00", ext_min: 30, kind: "meal" },
      snack: { label: "Black coffee + snacks", time: "17:30", ext_min: 30, kind: "checkin" },
      leave: { label: "Leave library / office", time: "22:00", ext_min: 30, kind: "checkin", days: [1, 2, 3, 4, 5, 6] },
      dinner: { label: "Dinner", time: "23:00", ext_min: 30, kind: "meal" },
      sleep: { label: "Sleep", time: "00:30", ext_min: 30, kind: "checkin", next_day: true },
    },
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
        else if (latest != null && bed != null && bed > latest && bed < 6 * 60) { bad = true; why = "bedtime " + row.bedtime + " logged (after " + R.latest_bed + " AM)"; }
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

// Timed anchors per day. State: ok | pending | excused | review | needs_allowance | missed | skip.
// Approved schedule changes [{ anchor, time, from: "YYYY-MM-DD" }] apply from their date on
// (never to days before it). The latest change per anchor wins.
const SHIFT_HM = /^([01]\d|2[0-3]):[0-5]\d$/;
function anchorsOn(AN, overrides, date) {
  if (!AN || !Array.isArray(overrides) || !overrides.length) return AN;
  const list = Object.assign({}, AN.list);
  overrides.filter(o => o && list[o.anchor] && SHIFT_HM.test(o.time || "") && String(o.from || "") <= date)
    .sort((a, b) => String(a.from).localeCompare(String(b.from)))
    .forEach(o => { list[o.anchor] = Object.assign({}, list[o.anchor], { time: o.time }); });
  return Object.assign({}, AN, { list });
}
function anchorCandidates({ policy, checkins, logs, marks, now }) {
  const AN0 = policy.anchors;
  if (!AN0) return [];
  const from = policy.effective_from ? istDate(policy.effective_from) : istDate(now);
  const out = [];
  for (let date = from; date <= istDate(now); date = addDays(date, 1)) {
    const row = (logs || []).find(r => r.day === date || r.date === date) || null;
    const weekday = new Date(date + "T12:00:00Z").getUTCDay();
    const sick = (marks || []).some(m => String(m.date).slice(0, 10) === date && m.kind === "recovery");
    const AN = anchorsOn(AN0, policy.schedule_overrides, date);
    for (const key of Object.keys(AN.list)) {
      const A = AN.list[key];
      if (A.days && !A.days.includes(weekday)) continue;
      const target = istAt(A.next_day ? addDays(date, 1) : date, A.time), deadline = target + A.ext_min * 60000;
      if (policy.effective_from && target <= Date.parse(policy.effective_from)) continue;
      const base = { key, date, label: A.label, target, deadline, checkpoint: deadline, root_key: key === "gym" ? "gym:" + date : "anchor:" + key + ":" + date };
      let t = null, client = null;
      if (A.kind === "meal") {
        t = row && row.entries_seen && row.entries_seen[key] ? Date.parse(row.entries_seen[key]) : null;
        client = row && row.entries && row.entries[key] ? Date.parse(row.entries[key]) : null;
      } else {
        const c = (checkins || []).filter(x => x.anchor === key && String(x.day).slice(0, 10) === date && x.verified !== false).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
        if (c) { t = Date.parse(c.at); client = c.client_at ? Date.parse(c.client_at) : null; }
      }
      if (t != null && t <= target) { out.push(Object.assign(base, { state: "ok", at: t })); continue; }
      if (deadline > now) { out.push(Object.assign(base, { state: "pending" })); continue; }
      if (sick) { out.push(Object.assign(base, { state: "excused", why: A.label + " — recovery (sick) day" })); continue; }
      if (key === "gym" && t == null) {
        const trained = row && (row.gym_done || (row.entries_seen && row.entries_seen.workout));
        if (!trained) { out.push(Object.assign(base, { state: "skip" })); continue; }   // a skipped gym day is the gym rule's job, not a second fine
      }
      const hm = ms => new Date(ms + 330 * 60000).toISOString().slice(11, 16);
      if (t != null && t <= deadline) { out.push(Object.assign(base, { state: "needs_allowance", at: t, why: A.label + " at " + hm(t) + " (target " + A.time + ", " + A.ext_min + " min extension)" })); continue; }
      if (client != null && client <= deadline) { out.push(Object.assign(base, { state: "review", why: A.label + " recorded on the phone at " + hm(client) + " but reached the server late" })); continue; }
      out.push(Object.assign(base, { state: "missed", why: t == null ? A.label + " — no " + (A.kind === "meal" ? "meal logged" : "check-in") + " by " + hm(deadline) : A.label + " at " + hm(t) + " — after the " + A.ext_min + " min extension (" + hm(deadline) + ")" }));
    }
  }
  return out;
}
function anchorExtras(policy, cands, decided) {
  const AN = policy.anchors, out = [];
  cands.forEach((c, i) => {
    if (["ok", "pending", "skip"].includes(c.state)) return;
    const id = "anchor:" + c.key + ":" + c.date;
    const inc = { id, source_key: id, commitment_id: null, category: "anchor", root_key: c.root_key, policy_version: policy.version, title: c.label + " — " + c.date, overlap_of: null, detail: { date: c.date, anchor: c.key, why: c.why || null } };
    const fine = why => out.push({ incident: Object.assign(inc, { status: "resolved" }), want: { incident_id: id, kind: "assessment", day_n: 1, local_date: c.date, raw: AN.after_paise, checkpoint: c.checkpoint, why } });
    if (c.state === "excused") { inc.status = "excused"; out.push({ incident: inc }); return; }
    if (c.state === "review") { inc.status = "review"; out.push({ incident: inc }); return; }
    if (c.state === "missed") return fine(c.why);
    const a = decided && decided[i] && decided[i].allowance;
    if (!a) return;
    if (a.ok) { inc.status = "allowance"; inc.detail.pass = (a.used || "?") + "/" + AN.passes; out.push({ incident: inc }); return; }
    fine(c.why + " — all " + AN.passes + " extensions used this month");
  });
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
      calc: { formula: w.kind === "escalation" || w.day_n > 1 ? "base × 2^(n-1)" : inc.category === "log" ? "flat per missing entry" : inc.category === "promise" ? "base" : inc.category === "anchor" ? "flat per late / missed anchor" : inc.category === "milestone" ? "milestone consequence (after the 48 h review window)" : "flat, after the month's passes ran out", raw_paise: w.raw, trimmed_by_cap: amount < w.raw,
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

// Applies a dispute review. The AI only recommends; this decides what is written.
// uphold → reversal rows for every assessed entry (originals stay), incident excused, pass released.
// reject → incident back to its previous status. need_more / no valid review → stays disputed (fine paused).
function disputeOutcome(review, dispute, incEntries, today) {
  const rec = review && ["uphold", "reject", "need_more"].includes(review.recommendation) && String(review.why || "").trim() ? review.recommendation : null;
  if (!rec || rec === "need_more") return { dispute: rec ? "need_more" : "open", incident: "disputed", reversals: [], releasePass: false };
  if (rec === "reject") return { dispute: "rejected", incident: dispute.prev_status, reversals: [], releasePass: false };
  const reversed = new Set(incEntries.filter(e => e.kind === "reversal" && e.reverses != null).map(e => String(e.reverses)));
  const reversals = incEntries.filter(e => e.kind !== "reversal" && Number(e.amount_paise) > 0 && !reversed.has(String(e.id))).map(e => ({
    incident_id: e.incident_id, kind: "reversal", day_n: e.day_n, local_date: String(e.local_date).slice(0, 10), amount_paise: -Number(e.amount_paise),
    reverses: e.id, policy_version: e.policy_version, created_by: "review",
    calc: { formula: "reversal of entry " + e.id, why: "Dispute upheld: " + String(review.why).slice(0, 300), dispute_id: dispute.id, decided_on: today } }));
  return { dispute: "upheld", incident: "excused", reversals, releasePass: true };
}

// ── Weight milestone: lose 10 kg in 12 weeks (+3-week extension) ──────────
// Outcome is judged on 7-day averages of fasted morning weigh-ins, never one reading.
// Adherence (did he follow the plan?) is judged separately from his logs; missing logs
// make it "unknown", never "not followed". Every consequence waits 48 h for a dispute.
const WEIGHT_RULES = {
  loss_kg: 10, weeks: 12, ext_weeks: 3, baseline_count: 3, baseline_window_days: 10,
  initial_paise: 50000, followed_paise: 100000, not_followed_paise: 300000, review_hours: 48,
  coverage_min: 0.7, followed_min: 0.85, not_followed_max: 0.6, fast_loss_pct_week: 1.0,
};
const qualifies = w => !!(w && w.fasted && w.morning && !w.superseded);
function liveWeighins(weighins) {
  const gone = new Set((weighins || []).map(w => w.supersedes).filter(Boolean));
  return (weighins || []).filter(w => !gone.has(w.id)).map(w => Object.assign({}, w, { day: String(w.day).slice(0, 10), kg: +w.kg }));
}
function meanWindow(weighins, endDay, days) {
  const from = addDays(endDay, -((days || 7) - 1));
  const v = liveWeighins(weighins).filter(w => qualifies(w) && w.day >= from && w.day <= endDay).map(w => w.kg);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 100) / 100 : null;
}
function baselineOf(weighins, fromDay, R) {
  const q = liveWeighins(weighins).filter(w => qualifies(w) && w.day >= fromDay && w.day <= addDays(fromDay, R.baseline_window_days))
    .sort((a, b) => Date.parse(a.measured_at) - Date.parse(b.measured_at));
  if (q.length < R.baseline_count) return { have: q.length };
  const first = q.slice(0, R.baseline_count);
  return { kg: Math.round(first.reduce((a, w) => a + w.kg, 0) / first.length * 100) / 100, day: first[first.length - 1].day, have: q.length };
}
function weightTrend(weighins, today, R) {
  const cur = meanWindow(weighins, today), prev = meanWindow(weighins, addDays(today, -7));
  if (cur == null || prev == null) return { cur, prev, pct_week: null, fast: false };
  const pct = Math.round((prev - cur) / prev * 1000) / 10;
  return { cur, prev, pct_week: pct, fast: pct > R.fast_loss_pct_week };
}
// Share of plan days without a fined gym/diet/sleep miss, and how many days have any log at all.
function adherence({ start, end, logs, entries, R }) {
  const days = []; for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  const logged = new Set((logs || []).map(r => String(r.day || "").slice(0, 10)));
  const net = {};
  (entries || []).forEach(e => { if (/^(gym|diet|sleep):/.test(e.incident_id)) net[e.incident_id] = (net[e.incident_id] || 0) + Number(e.amount_paise); });
  const fined = new Set(Object.keys(net).filter(k => net[k] > 0).map(k => k.split(":")[1]).filter(d => d >= start && d <= end));
  const coverage = days.length ? days.filter(d => logged.has(d)).length / days.length : 0;
  const pct = days.length ? 1 - fined.size / days.length : 0;
  const status = coverage < R.coverage_min ? "unknown" : pct >= R.followed_min ? "followed" : pct <= R.not_followed_max ? "not_followed" : "partial";
  return { status, coverage: Math.round(coverage * 100), pct: Math.round(pct * 100), fined_days: fined.size, days: days.length };
}
function weightPlan({ goal, weighins, logs, entries, now, version }) {
  const out = { patch: null, extras: [], info: {} };
  if (!goal || goal.status === "cancelled") return out;
  const R = Object.assign({}, WEIGHT_RULES, goal.rules || {}), today = istDate(now);
  let g = Object.assign({}, goal);
  if (g.status === "baseline") {
    const b = baselineOf(weighins, istDate(g.requested_at), R);
    out.info.baseline_have = b.have;
    if (b.kg == null) return out;
    g = Object.assign(g, { status: "active", baseline_kg: b.kg, baseline_day: b.day, start_day: b.day,
      end_day: addDays(b.day, R.weeks * 7), ext_end_day: addDays(b.day, (R.weeks + R.ext_weeks) * 7) });
    out.patch = { status: "active", baseline_kg: b.kg, baseline_day: b.day, start_day: g.start_day, end_day: g.end_day, ext_end_day: g.ext_end_day };
  }
  const target = Math.round((+g.baseline_kg - R.loss_kg) * 100) / 100;
  out.info = Object.assign(out.info, { target, trend: weightTrend(weighins, today, R) });
  const mk = (phase, endDay, proposed, why, detail) => {
    const id = "milestone:" + g.id + ":" + phase, reviewUntil = istAt(addDays(endDay, 1), "00:00") + R.review_hours * 3600000;
    const inc = { id, source_key: id, commitment_id: null, category: "milestone", root_key: id, policy_version: version,
      title: (phase === "initial" ? "Weight goal (12 weeks)" : "Weight goal (extension)") + " — " + endDay, overlap_of: null,
      detail: Object.assign({ date: endDay, why, proposed_paise: proposed, review_until: new Date(reviewUntil).toISOString() }, detail), status: "review" };
    const x = { incident: inc };
    if (proposed && now >= reviewUntil) {
      inc.status = "resolved";
      x.want = { incident_id: id, kind: "assessment", day_n: 1, local_date: istDate(reviewUntil), raw: proposed, checkpoint: reviewUntil, why };
    }
    out.extras.push(x);
  };
  let status = g.status;
  if (today > g.end_day && ["active", "extension", "missed", "achieved"].includes(status)) {
    const m = meanWindow(weighins, g.end_day), lost = m == null ? null : Math.round((+g.baseline_kg - m) * 100) / 100;
    if (m != null && m <= target) status = "achieved";
    else {
      mk("initial", g.end_day, m == null ? null : R.initial_paise,
        m == null ? "No fasted morning weigh-in in the last week of the 12 weeks — outcome unknown, so no fine; weigh in to continue"
          : "Lost " + lost + " kg of " + R.loss_kg + " in " + R.weeks + " weeks (7-day average " + m + " kg vs target " + target + " kg) — " + R.ext_weeks + "-week extension started",
        { baseline_kg: +g.baseline_kg, end_mean_kg: m, lost_kg: lost, target_kg: target });
      if (status === "active") status = "extension";
    }
  }
  if (today > g.ext_end_day && (status === "extension" || status === "missed")) {
    const m = meanWindow(weighins, g.ext_end_day), lost = m == null ? null : Math.round((+g.baseline_kg - m) * 100) / 100;
    if (m != null && m <= target) status = "achieved";
    else {
      const adh = adherence({ start: g.start_day, end: g.ext_end_day, logs, entries, R });
      const amount = m == null ? null : adh.status === "followed" ? R.followed_paise : adh.status === "not_followed" ? R.not_followed_paise : null;
      const why = m == null ? "No fasted morning weigh-in in the last week of the extension — outcome unknown, no fine"
        : adh.status === "followed" ? "Target missed even though the plan was followed (" + adh.pct + "% of days on plan) — the plan itself needs review"
        : adh.status === "not_followed" ? "Target missed and the plan wasn't followed (" + adh.pct + "% of days on plan, " + adh.fined_days + " fined misses)"
        : adh.status === "unknown" ? "Target missed, but logs cover only " + adh.coverage + "% of days — adherence unknown, review only, no fine"
        : "Target missed with partial adherence (" + adh.pct + "%) — review only, no fine";
      mk("extension", g.ext_end_day, amount, why, { baseline_kg: +g.baseline_kg, end_mean_kg: m, lost_kg: lost, target_kg: target, adherence: adh,
        overlap_note: adh.fined_days ? adh.fined_days + " of these days were already fined separately; this is the outcome consequence, shown separately" : null });
      status = "missed";
    }
  }
  if (status !== goal.status) out.patch = Object.assign(out.patch || {}, { status });
  return out;
}

module.exports = { anchorsOn, POLICY_V1, plan, disputeOutcome, anchorCandidates, anchorExtras, WEIGHT_RULES, weightPlan, meanWindow, baselineOf, weightTrend, adherence, promiseDue, logStatus, capTrim, istDate, istAt, addDays, rupees, exceptionCandidates, exceptionExtras, bedMinutes };
