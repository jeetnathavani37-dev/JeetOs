// api/_approvals.js — the Approval Centre (pure). Everything waiting on Jeet's
// yes/no, in one list, most consequential first. Nothing here changes on its
// own: each item names the exact action that applies it, and that action goes
// through the same endpoint (and rules) as before.
const day10 = d => String(d || "").slice(0, 10);
const ageDays = (at, today) => (at ? Math.max(0, Math.round((Date.parse(today) - Date.parse(day10(at))) / 864e5)) : null);
const clip = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);

// Lower rank = shown first.
const RANK = { goal_plan: 1, schedule: 2, plan_change: 3, memory_retract: 4, memory_confirm: 5, journal_review: 6, memory_stale: 7 };

function collect(src, today) {
  src = src || {};
  const items = [];
  const add = (type, id, title, detail, at, actions, extra) => items.push(Object.assign({ key: type + ":" + id, type, id, title: clip(title, 220), detail: detail ? clip(detail, 300) : null, age_days: ageDays(at, today), actions }, extra || {}));

  if (src.goalProposal) add("goal_plan", "plan", "Approve the goal plan", `${src.goalProposal.length} goals: ${src.goalProposal.filter(g => g.kind === "primary").map(g => g.title).join(", ")} + supporting goals. Nothing is tracked against goals until you approve.`, null,
    [{ label: "Approve", op: { action: "goals.approve" } }]);
  (src.repairs || []).forEach(r => add("schedule", r.id, r.text, r.effect, null,
    [{ label: "Approve", op: { action: "repair.approve", id: r.id } }, { label: "No", op: { action: "repair.reject", id: r.id } }]));
  (src.pendingDecisions || []).forEach(d => add("plan_change", d.id, `${d.coach}: ${d.change}`, [d.reason && `why: ${d.reason}`, d.evidence && `evidence: ${d.evidence}`].filter(Boolean).join(" · "), d.created_at,
    [{ label: "Approve", op: { client: "decide", id: d.id, approve: true } }, { label: "No", op: { client: "decide", id: d.id, approve: false } }], { coach: d.coach }));
  const mems = (src.memories || []).filter(m => !String(m.scope || "").startsWith("private:"));   // mind-coach facts stay in the Memory card
  mems.filter(m => m.pending === "retract").forEach(m => add("memory_retract", m.id, `No longer true? "${m.text}"`, m.pending_reason, m.updated_at,
    [{ label: "Remove it", op: { action: "memory.act", id: m.id, op: "retract" } }, { label: "Still true", op: { action: "memory.act", id: m.id, op: "keep" } }]));
  mems.filter(m => m.status === "unconfirmed" && m.pending !== "retract").forEach(m => add("memory_confirm", m.id, `Is this right? "${m.text}"`, m.coach ? `${m.coach} guessed this — coaches treat it as a guess until you confirm` : null, m.observed_at,
    [{ label: "Yes", op: { action: "memory.act", id: m.id, op: "confirm" } }, { label: "No", op: { action: "memory.act", id: m.id, op: "retract" } }]));
  const due = d => d.review_on ? day10(d.review_on) : d.decided_at ? new Date(Date.parse(day10(d.decided_at)) + 14 * 864e5).toISOString().slice(0, 10) : null;
  (src.journal || []).filter(d => d.status === "approved" && !d.verdict && due(d) && due(d) <= today).forEach(d => add("journal_review", d.id, `Did it work? ${d.change}`, d.expected_outcome ? `expected: ${d.expected_outcome}` : null, due(d),
    [{ label: "Worked", op: { action: "journal.outcome", id: d.id, verdict: "worked" } }, { label: "Didn't", op: { action: "journal.outcome", id: d.id, verdict: "didnt" } }, { label: "Unclear", op: { action: "journal.outcome", id: d.id, verdict: "unclear" } }]));
  mems.filter(m => m.status === "active" && !m.pending && m.review_after && day10(m.review_after) <= today).slice(0, 5).forEach(m => add("memory_stale", m.id, `Still true? "${m.text}"`, `last checked ${day10(m.observed_at)}`, m.review_after,
    [{ label: "Still true", op: { action: "memory.act", id: m.id, op: "confirm" } }, { label: "Not anymore", op: { action: "memory.act", id: m.id, op: "retract" } }]));

  items.sort((a, b) => RANK[a.type] - RANK[b.type] || (b.age_days || 0) - (a.age_days || 0));
  return { items, count: items.length, by_type: items.reduce((o, i) => (o[i.type] = (o[i.type] || 0) + 1, o), {}) };
}

// Only these server actions may be sent from the Approval Centre.
const ALLOWED = new Set(["goals.approve", "repair.approve", "repair.reject", "memory.act", "journal.outcome"]);

module.exports = { collect, ALLOWED, RANK };
