// api/telegram-weekly-report.js
// Sends a Sunday-only weekly report card to Telegram, graded in CR7's voice,
// using the last 7 synced days from Supabase (jeetos_logs).
// Triggered by Vercel Cron — see vercel.json ("30 15 * * 0" = Sun 9pm IST).
//
// Extended with an insight-analyst layer: pulls unresolved psychologist
// patterns (jeetos_excuse_log) and this week's stake ledger
// (jeetos_stake_ledger) and appends them to the same report, so it's one
// message instead of three separate ones.

const GRADES = [
  { min: 90, grade: "S", msg: "SIUUU! CR7 himself would approve. This is the standard — don't let it slip." },
  { min: 80, grade: "A", msg: "Strong week. This is what consistency actually looks like when it compounds." },
  { min: 70, grade: "A-", msg: "Solid. CR7 trains like this every single week — not just the good ones." },
  { min: 60, grade: "B", msg: "Decent. But Ronaldo does not do decent — pick one number and fix it this week." },
  { min: 50, grade: "C", msg: "Average. Tere saath average nahi chalega — tighten it up." },
  { min: 40, grade: "D", msg: "Below standard. He's had worse weeks through injury and still came back sharper." },
  { min: 0, grade: "F", msg: "Bhai seriously? This week didn't happen the way it should have. Reset Monday, no excuses." },
];

function gradeFor(score) {
  return GRADES.find((g) => score >= g.min) || GRADES[GRADES.length - 1];
}

function supaHeaders(key) {
  return { apikey: key, Authorization: "Bearer " + key };
}

async function fetchUnresolvedPatterns(SUPABASE_URL, key) {
  try {
    const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/jeetos_excuse_log?date=gte.${since}&repeat_count=gte.2&solution_applied=eq.false&select=*&order=date.desc&limit=3`,
      { headers: supaHeaders(key) }
    );
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    return [];
  }
}

async function fetchStakeWeek(SUPABASE_URL, key) {
  try {
    const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/jeetos_stake_ledger?date=gte.${since}&select=*`,
      { headers: supaHeaders(key) }
    );
    const rows = await r.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const charged = rows.filter((r) => !r.waived);
    const waived = rows.filter((r) => r.waived);
    const total = charged.reduce((s, r) => s + Number(r.amount || 0), 0);
    return { chargedCount: charged.length, waivedCount: waived.length, total };
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  const auth = req.headers["authorization"];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!token || !chatId) {
    return res.status(500).json({ error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY" });
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/jeetos_logs?select=*&order=updated_at.desc&limit=7`,
      { headers: supaHeaders(SUPABASE_KEY) }
    );
    const rows = await r.json();

    if (!Array.isArray(rows) || rows.length === 0) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          parse_mode: "Markdown",
          text: "🐐 *CR7 — Weekly Report*\n\nNo logged days this week. Talent without working hard is nothing — and neither is a week with nothing logged. Start today.",
        }),
      });
      return res.status(200).json({ success: true, days: 0 });
    }

    const n = rows.length;
    const gymDays = rows.filter((d) => d.gym_done).length;
    const skinDays = rows.filter((d) => d.skincare_done).length;
    const avgSleep = rows.reduce((s, d) => s + (d.sleep_hours || 0), 0) / n;
    const avgProtein = rows.reduce((s, d) => s + (d.total_protein || 0), 0) / n;
    const avgWater = rows.reduce((s, d) => s + (d.water || 0), 0) / n;

    const score =
      ((gymDays / 7) * 100 +
        Math.min(100, (avgSleep / 7.5) * 100) +
        Math.min(100, (avgProtein / 170) * 100) +
        Math.min(100, (avgWater / 9) * 100) +
        (skinDays / 7) * 100) /
      5;

    const g = gradeFor(score);

    let text =
      `🐐 *CR7 — Weekly Report Card*\n\n` +
      `Grade: *${g.grade}*  (${Math.round(score)}/100)\n\n` +
      `Gym: ${gymDays}/7 days\n` +
      `Sleep avg: ${avgSleep.toFixed(1)}h\n` +
      `Protein avg: ${Math.round(avgProtein)}g\n` +
      `Water avg: ${avgWater.toFixed(1)} glasses\n` +
      `Skincare: ${skinDays}/7 days\n` +
      `Days logged: ${n}/7\n\n` +
      `_${g.msg}_`;

    // insight-analyst layer — unresolved patterns
    const patterns = await fetchUnresolvedPatterns(SUPABASE_URL, SUPABASE_KEY);
    if (patterns.length > 0) {
      const p = patterns[0];
      text +=
        `\n\n🔍 *Unresolved pattern:* "${p.reason_given}"\n` +
        `Solution offered (${p.solution_offered}) — not yet confirmed applied, ${p.repeat_count}x recently.`;
    }

    // insight-analyst layer — stake summary
    const stakeWeek = await fetchStakeWeek(SUPABASE_URL, SUPABASE_KEY);
    if (stakeWeek) {
      text += `\n\n💸 *Stakes:* ${stakeWeek.chargedCount} charged (₹${stakeWeek.total}), ${stakeWeek.waivedCount} waived`;
    }

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });

    return res.status(200).json({ success: true, score: Math.round(score), grade: g.grade, days: n });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
