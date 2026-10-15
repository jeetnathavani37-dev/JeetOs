// api/schedule-ics.js — his daily anchors as an iPhone/Google calendar file.
// Opening /api/schedule.ics on the iPhone offers "Add all events": each anchor repeats
// daily (or Mon–Sat) with an alert 10 min before and one at the time. Calendar alerts
// fire on time without the app or the internet. No personal data here — just the times.
const { POLICY_V1 } = require("./_penalty");

const ICON = { wake: "⏰", gym: "🏋️", breakfast: "🍳", work: "📚", lunch: "🍛", snack: "☕", leave: "🚪", dinner: "🍽️", sleep: "🌙" };
const NOTE = {
  wake: "Utho! 9:00 tak extension (pass lagega). JeetOS mein 'Utha ✓' dabao.",
  gym: "9:30 gym reporting. Pahunch ke 'Gym pahuncha' dabao.",
  breakfast: "11:30 breakfast — meal log/tick karo.",
  work: "12:30 library/work. Pahunch ke 'Library pahuncha' dabao.",
  lunch: "3:00 lunch — meal log karo.",
  snack: "5:30 black coffee + snacks.",
  leave: "10:00 PM tak library se nikalna.",
  dinner: "11:00 PM dinner — meal log karo.",
  sleep: "12:30 tak so jao. 'So raha hoon' dabao.",
};
const DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

module.exports = function handler(req, res) {
  const list = POLICY_V1.anchors.list;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const start = "20261016";
  const ev = Object.keys(list).map(k => {
    const A = list[k], [h, m] = A.time.split(":");
    const days = A.days ? "BYDAY=" + A.days.map(d => DAY[d]).join(",") + ";" : "";
    const t = h + m + "00", end = String((+h * 60 + +m + 15) % 1440 / 60 | 0).padStart(2, "0") + String((+m + 15) % 60).padStart(2, "0") + "00";
    return ["BEGIN:VEVENT", "UID:jeetos-anchor-" + k + "@jeetos", "DTSTAMP:" + stamp,
      "DTSTART;TZID=Asia/Kolkata:" + start + "T" + t, "DTEND;TZID=Asia/Kolkata:" + start + "T" + (end > t ? end : t),
      "RRULE:FREQ=" + (A.days ? "WEEKLY;" + days.replace(/;$/, "") : "DAILY"),
      "SUMMARY:" + ICON[k] + " " + A.label, "DESCRIPTION:" + NOTE[k] + " (Extension " + A.ext_min + " min)",
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + A.label + " in 10 min", "TRIGGER:-PT10M", "END:VALARM",
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + A.label + " — abhi", "TRIGGER:PT0M", "END:VALARM",
      "END:VEVENT"].join("\r\n");
  });
  const body = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//JeetOS//Daily anchors//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:JeetOS — mera din", "X-WR-TIMEZONE:Asia/Kolkata",
    "BEGIN:VTIMEZONE", "TZID:Asia/Kolkata", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0530", "TZOFFSETTO:+0530", "TZNAME:IST", "END:STANDARD", "END:VTIMEZONE"]
    .concat(ev, ["END:VCALENDAR"]).join("\r\n") + "\r\n";
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="jeetos-schedule.ics"');
  res.setHeader("Cache-Control", "no-cache");
  return res.status(200).send(body);
};
