// api/_notify.js — the notification budget (pure, no I/O).
// Every push goes through decide() first, so he gets useful pings, not spam:
//  - alarm    his own schedule anchors (wake, gym, meals, sleep…) — always allowed,
//             up to a hard ceiling
//  - deadline money / settle-up / promise deadlines — allowed a little past the cap
//  - nudge    coach check-ins, streak rescue, reviews — only while under the daily
//             cap, never in quiet hours, and not within an hour of another nudge
//  - test     the "Test bhejo" button — always
// If the day's log can't be read, the cap fails open (better a ping than a missed
// alarm) but quiet hours still hold.
const DEFAULTS = { daily_cap: 8, quiet_from: "00:45", quiet_to: "07:45", nudge_gap_min: 60 };
const LIMITS = { daily_cap: [3, 15], nudge_gap_min: [0, 240] };
const ALARM_CEILING = 14, DEADLINE_EXTRA = 2;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

function classOf(tag) {
  const t = String(tag || "");
  if (t === "test") return "test";
  if (/-a_[a-z]+$/.test(t)) return "alarm";
  if (/^(settle|ledger|deadline|promise)-/.test(t)) return "deadline";
  return "nudge";
}
const mins = hm => { const [h, m] = String(hm).split(":").map(Number); return h * 60 + m; };
function inQuiet(nowMin, from, to) {
  const f = mins(from), t = mins(to);
  return f <= t ? nowMin >= f && nowMin < t : nowMin >= f || nowMin < t;   // window may wrap midnight
}
function settingsOf(raw) {
  const s = Object.assign({}, DEFAULTS);
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(LIMITS)) { const v = Number(raw[k]); if (isFinite(v) && v >= LIMITS[k][0] && v <= LIMITS[k][1]) s[k] = Math.round(v); }
    if (HM.test(raw.quiet_from || "") && HM.test(raw.quiet_to || "")) { s.quiet_from = raw.quiet_from; s.quiet_to = raw.quiet_to; }
  }
  return s;
}
// sentToday: rows of { cls, at } already SENT today (IST), or null if unknown.
function decide({ tag, now, sentToday, settings }) {
  const s = settingsOf(settings), cls = classOf(tag);
  const ist = new Date(now + 330 * 60000), nowMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (cls === "test") return { ok: true, cls };
  if (cls !== "alarm" && inQuiet(nowMin, s.quiet_from, s.quiet_to)) return { ok: false, cls, reason: `quiet hours ${s.quiet_from}–${s.quiet_to}` };
  if (!Array.isArray(sentToday)) return { ok: true, cls, reason: "budget unknown (log unreadable) — sent" };
  const n = sentToday.length;
  if (cls === "alarm") return n < ALARM_CEILING ? { ok: true, cls } : { ok: false, cls, reason: `hard ceiling ${ALARM_CEILING}/day` };
  if (cls === "deadline") return n < s.daily_cap + DEADLINE_EXTRA ? { ok: true, cls } : { ok: false, cls, reason: "daily cap reached" };
  if (n >= s.daily_cap) return { ok: false, cls, reason: `daily cap ${s.daily_cap} reached` };
  const lastNudge = sentToday.filter(r => r.cls === "nudge").map(r => Date.parse(r.at)).sort((a, b) => b - a)[0];
  if (lastNudge && s.nudge_gap_min && now - lastNudge < s.nudge_gap_min * 60000) return { ok: false, cls, reason: `another nudge ${Math.round((now - lastNudge) / 60000)} min ago` };
  return { ok: true, cls };
}

module.exports = { decide, classOf, settingsOf, inQuiet, DEFAULTS, LIMITS, ALARM_CEILING };
