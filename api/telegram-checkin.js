// api/telegram-checkin.js
// Sends a CR7-styled check-in message to Jeet's Telegram (t.me/JN18_bot).
// Triggered by Vercel Cron — see vercel.json — with ?type=morning or ?type=night.
// Can also be hit manually in a browser to test.

const MORNING_MESSAGES = [
  "Every morning I wake up thinking today I will be better than yesterday. Get up. Open JeetOS and start the day.",
  "I don't wait for the mood to be right, I make it right by working. First thing today: log your gym day in JeetOS.",
  "Talent without working hard is nothing. Plan is nothing without today's execution — open JeetOS and see today's split.",
  "Discipline starts the moment you wake up, not when you feel like it. Morning drink, water, gym plan — log it now.",
  "Champions are not born in gyms, they're built one disciplined morning at a time. This one's yours — go.",
];

const NIGHT_MESSAGES = [
  "Extra reps after everyone else stops — that's where the gap gets made. Before you sleep, log today in JeetOS.",
  "I review my own day harder than any critic would. Time to review yours — open JeetOS and check in.",
  "Discipline in food is discipline everywhere else. Did you hit your protein target today? Log it before bed.",
  "Rest when the work is actually done, not before. Close today out properly — JeetOS check-in.",
  "Your love makes me strong, your hate makes me unstoppable — either way, show up. Log today before you sleep.",
  "Sleep is part of training, not separate from it. Log today's numbers, then protect your 7.5 hours.",
];

function pickMessage(list) {
  const start = new Date(new Date().getFullYear(), 0, 0);
  const dayOfYear = Math.floor((new Date() - start) / 86400000);
  return list[dayOfYear % list.length];
}

module.exports = async function handler(req, res) {
  const auth = req.headers["authorization"];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return res.status(500).json({ error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars" });
  }

  const type = (req.query && req.query.type) || "night";
  const list = type === "morning" ? MORNING_MESSAGES : NIGHT_MESSAGES;
  const label = type === "morning" ? "🐐 CR7 Morning" : "🐐 CR7 Check-In";
  const text = `*${label}*\n\n${pickMessage(list)}`;

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
    const data = await r.json();
    if (!data.ok) {
      return res.status(500).json({ error: data.description || "Telegram send failed" });
    }
    return res.status(200).json({ success: true, type });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
