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

// Trims an amount to the remaining incident / day / month allowance.
function capTrim(raw, sums, caps) {
  const room = Math.min(caps.incident_paise - sums.incident, caps.day_paise - sums.day, caps.month_paise - sums.month);
  return Math.max(0, Math.min(raw, room));
}

// Everything the ledger should contain now. `entries` = existing ledger rows.
function plan({ policy, commitments, logs, entries, incidents, now }) {
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
      calc: { formula: w.kind === "escalation" || w.day_n > 1 ? "base × 2^(n-1)" : (inc.category === "log" ? "flat per missing entry" : "base"), raw_paise: w.raw, trimmed_by_cap: amount < w.raw,
        sums_before: sums, caps, checkpoint: new Date(w.checkpoint).toISOString(), why: w.why, mode: policy.mode } });
  }
  // An incident that has used its whole per-incident cap stays capped.
  for (const inc of incOut.values()) if (inc.category === "promise" && sumFor(e => e.incident_id === inc.id) >= caps.incident_paise) inc.status = "capped";
  return { incidents: [...incOut.values()], entries: added };
}

module.exports = { POLICY_V1, plan, promiseDue, logStatus, capTrim, istDate, istAt, addDays, rupees };
