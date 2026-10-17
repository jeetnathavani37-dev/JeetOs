// api/_whatif.js — the what-if simulator (pure, no I/O).
// "If I eat X kcal and train Y days a week, when do I hit my target?" and
// "If I sleep at A and wake at B, does it fit my rules?". Everything comes
// from his own data with the assumptions written out, answers are ranges
// (never one confident date), and when his data can't support an answer it
// says so instead of guessing. Nothing is saved or changed.
const { addDays, meanWindow, WEIGHT_RULES, bedMinutes } = require("./_penalty");

const KCAL_PER_KG = 7700;
const GYM_BURN = [250, 400];                 // kcal per extra/fewer session — an assumption, shown as a range
const LOGGING_SLACK = 200;                   // logged calories are usually a bit under — widen the maintenance range
const MIN_KCAL_DAYS = 14, MIN_WEIGHINS_EACH = 2, WINDOW = 28;
const day10 = d => String(d || "").slice(0, 10);
const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;

// Maintenance calories from his own logs + weight change over the last 28 days, or null with why.
function maintenanceFromData(raw, today) {
  const from = addDays(today, -WINDOW), end = addDays(today, -1);
  const kcal = (raw.logs || []).filter(l => day10(l.day) >= from && day10(l.day) <= end && l.total_cal != null && +l.total_cal > 600).map(l => +l.total_cal);
  const live = (raw.weighins || []).filter(w => w.fasted && w.morning);
  const early = live.filter(w => day10(w.day) >= from && day10(w.day) < addDays(from, 7)).length;
  const late = live.filter(w => day10(w.day) > addDays(end, -7) && day10(w.day) <= end).length;
  const need = [];
  if (kcal.length < MIN_KCAL_DAYS) need.push(`${MIN_KCAL_DAYS - kcal.length} more days of calorie logs (have ${kcal.length} of the last ${WINDOW})`);
  if (early < MIN_WEIGHINS_EACH || late < MIN_WEIGHINS_EACH) need.push(`fasted weigh-ins at the start and end of the 4 weeks (have ${early} and ${late}, need ${MIN_WEIGHINS_EACH} each)`);
  if (need.length) return { kcal: null, need };
  const wStart = meanWindow(raw.weighins, addDays(from, 6), 7), wEnd = meanWindow(raw.weighins, end, 7);
  const avg = kcal.reduce((a, b) => a + b, 0) / kcal.length, days = WINDOW - 7;   // window centres are 21 days apart
  const est = Math.round(avg + (wStart - wEnd) * KCAL_PER_KG / days);
  return { kcal: est, range: [est - 100, est + LOGGING_SLACK], avg_logged: Math.round(avg), kcal_days: kcal.length, w_start: wStart, w_end: wEnd, source: "your logs + weight trend (last 4 weeks)" };
}

function gymDaysPerWeek(raw, today) {
  const from = addDays(today, -WINDOW);
  const days = new Set((raw.checkins || []).filter(c => c.anchor === "gym" && day10(c.day) >= from && day10(c.day) < today).map(c => day10(c.day)));
  (raw.logs || []).filter(l => l.gym_done && day10(l.day) >= from && day10(l.day) < today).forEach(l => days.add(day10(l.day)));
  return r1(days.size / (WINDOW / 7));
}

// input: { kcal, gym_days, maintenance?, target_kg? }
function weightWhatIf(input, raw, today) {
  const i = input || {}, kcal = Math.round(+i.kcal), gym = Math.round(+i.gym_days);
  if (!(kcal >= 1200 && kcal <= 4000)) return { error: "calories must be 1,200–4,000 a day" };
  if (!(gym >= 0 && gym <= 6)) return { error: "gym days must be 0–6 a week" };
  const now = meanWindow(raw.weighins || [], addDays(today, -1), 7) ?? meanWindow(raw.weighins || [], addDays(today, -1), 14);
  if (now == null) return { unknown: true, need: ["a few fasted morning weigh-ins this week"], text: "Abhi ka weight pata nahi — pehle 2-3 fasted morning weigh-ins karo." };
  const g = raw.weightGoal, goalTarget = g && g.baseline_kg ? r2(+g.baseline_kg - (+g.target_loss_kg || WEIGHT_RULES.loss_kg)) : null;
  const target = i.target_kg != null && i.target_kg !== "" ? +i.target_kg : goalTarget;
  if (!(target > 30 && target < now)) return { error: target == null ? "set a target weight (or start the weight goal)" : "target must be below your current weight" };
  const assumptions = [];
  let m;
  if (i.maintenance != null && i.maintenance !== "") {
    const v = Math.round(+i.maintenance);
    if (!(v >= 1400 && v <= 4500)) return { error: "maintenance must be 1,400–4,500" };
    m = { kcal: v, range: [v - 150, v + 150], source: "the number you entered" };
    assumptions.push(`maintenance ${v} kcal is your own number (±150)`);
  } else {
    m = maintenanceFromData(raw, today);
    if (m.kcal == null) return { unknown: true, need: m.need, text: "Tumhare data se maintenance calories abhi nahi nikal sakte — chahiye: " + m.need.join("; ") + ". Ya apna maintenance number khud daalo." };
    assumptions.push(`maintenance ≈ ${m.range[0]}–${m.range[1]} kcal from ${m.source} (logged avg ${m.avg_logged} kcal over ${m.kcal_days} days)`);
  }
  const curGym = gymDaysPerWeek(raw, today), extra = gym - curGym;
  if (Math.abs(extra) >= 0.5) assumptions.push(`gym ${gym}×/week vs your recent ${curGym}×: ${extra > 0 ? "+" : ""}${r1(extra)} sessions × ${GYM_BURN[0]}–${GYM_BURN[1]} kcal each`);
  assumptions.push(`1 kg of fat ≈ ${KCAL_PER_KG} kcal; water and food weight make the scale jump day to day`);
  const gymDay = [extra * GYM_BURN[0] / 7, extra * GYM_BURN[1] / 7].sort((a, b) => a - b);
  const deficit = [m.range[0] + gymDay[0] - kcal, m.range[1] + gymDay[1] - kcal];      // slow … fast
  const perWeek = deficit.map(d => r2(d * 7 / KCAL_PER_KG));
  const toLose = r2(now - target), flags = [];
  if (kcal < 1500) flags.push("Below 1,500 kcal is too low to keep up safely — the team won't plan on it.");
  const pct = perWeek.map(w => r2(w / now * 100));
  if (pct[1] > WEIGHT_RULES.fast_loss_pct_week) flags.push(`Up to ${pct[1]}% of body weight a week is faster than the ${WEIGHT_RULES.fast_loss_pct_week}% safe limit — expect muscle loss and rebound.`);
  const out = { now_kg: now, target_kg: target, to_lose_kg: toLose, kcal, gym_days: gym, maintenance: m, kg_per_week: perWeek, assumptions, flags };
  if (perWeek[1] <= 0) return Object.assign(out, { reach: null, text: `At ${kcal} kcal you'd be at or above maintenance — the weight won't come down.` });
  const weeks = [perWeek[1] > 0 ? Math.ceil(toLose / perWeek[1]) : null, perWeek[0] > 0 ? Math.ceil(toLose / perWeek[0]) : null];   // fastest … slowest
  const dates = weeks.map(w => (w == null ? null : addDays(today, w * 7)));
  const deadline = g && g.end_day ? day10(g.end_day) : null;
  const verdict = !deadline ? null : dates[1] && dates[1] <= deadline ? "on_track" : dates[0] && dates[0] <= deadline ? "maybe" : "late";
  const text = `${now} → ${target} kg (−${toLose} kg): about ${Math.max(0, perWeek[0])}–${perWeek[1]} kg a week → ${weeks[1] == null ? `${weeks[0]}+ weeks (at the slow end it may stall)` : `${weeks[0]}–${weeks[1]} weeks`}, around ${dates[0]}${dates[1] ? " to " + dates[1] : " or later"}.` +
    (deadline ? ` Your 12-week goal ends ${deadline}: ${verdict === "on_track" ? "this gets there in time" : verdict === "maybe" ? "only the fast end gets there in time" : "this won't get there in time"}.` : "");
  return Object.assign(out, { weeks, dates, deadline, verdict, text });
}

// Sleep: bed + wake (HH:MM) → hours, and his rules (6h+, in bed by 12:30, up by 8, time before 9:30 gym).
function sleepWhatIf(input) {
  const i = input || {}, HM = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!HM.test(i.bed || "") || !HM.test(i.wake || "")) return { error: "bed and wake must be HH:MM" };
  const toMin = hm => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
  const bed = toMin(i.bed), wake = toMin(i.wake), hours = r2((((wake - bed) % 1440) + 1440) % 1440 / 60);
  const bm = bedMinutes(i.bed), onTime = bm <= 30 || bm >= 18 * 60;     // same rule as the sleep habit
  const checks = [
    { rule: "6h+ sleep", ok: hours >= 6, detail: `${hours} h` },
    { rule: "in bed by 12:30 AM", ok: onTime, detail: i.bed },
    { rule: "up by 8:00 AM", ok: wake <= 8 * 60 && wake >= 4 * 60, detail: i.wake },
    { rule: "1h+ before 9:30 gym", ok: wake <= 8 * 60 + 30 && wake >= 4 * 60, detail: wake <= 8 * 60 + 30 ? `${9 * 60 + 30 - wake} min before gym` : "too close to gym" },
  ];
  if (hours > 11) checks.push({ rule: "realistic", ok: false, detail: "more than 11 h — check the times" });
  const bad = checks.filter(c => !c.ok);
  return { hours, checks, ok: !bad.length, text: bad.length ? `${hours} h of sleep — breaks: ${bad.map(c => c.rule).join(", ")}.` : `${hours} h of sleep — fits all your sleep rules.` };
}

module.exports = { maintenanceFromData, gymDaysPerWeek, weightWhatIf, sleepWhatIf, KCAL_PER_KG, GYM_BURN };
