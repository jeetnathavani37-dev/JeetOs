// api/telegram-webhook.js
// Handles incoming Telegram messages to JN18_bot. /today pulls live JeetOS
// data (synced from the app to Supabase) and replies in CR7's voice.
// One-time setup: visit
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR_APP.vercel.app/api/telegram-webhook
// once from a browser to point Telegram at this endpoint.

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  const update = req.body || {};
  const msg = update.message;
  if (!msg || !msg.text) return res.status(200).json({ ok: true });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = msg.chat.id;
  const text = msg.text.trim().toLowerCase();

  const reply = async (t) => {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: t, parse_mode: "Markdown" }),
    });
  };

  if (text === "/today" || text === "/status") {
    const dateStr = new Date().toDateString();
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      await reply("Supabase isn't configured on the server yet — add SUPABASE_URL and SUPABASE_ANON_KEY as Vercel env vars.");
      return res.status(200).json({ ok: true });
    }

    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/jeetos_logs?date=eq.${encodeURIComponent(dateStr)}&select=*`,
        { headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY } }
      );
      const rows = await r.json();
      const d = Array.isArray(rows) ? rows[0] : null;

      if (!d) {
        await reply("🐐 *CR7*\n\nNothing logged yet today. I don't wait for the day to be over to start working — open JeetOS and log something.");
      } else {
        const lines = [
          `Gym: ${d.gym_done ? "✅ done" : "❌ not yet"}`,
          `Sleep: ${d.sleep_hours || 0}h`,
          `Protein: ${d.total_protein || 0}g`,
          `Water: ${d.water || 0} glasses`,
          `Skincare: ${d.skincare_done ? "✅ done" : "❌ not yet"}`,
        ];
        const onStandard = d.gym_done && (d.sleep_hours || 0) >= 7 && (d.total_protein || 0) >= 140;
        const verdict = onStandard
          ? "This is a Ronaldo day. Repeat it tomorrow — that's the hard part."
          : "Not the standard yet. Fix the weakest number before you sleep.";
        await reply(`🐐 *CR7 — Today's Status*\n\n${lines.join("\n")}\n\n_${verdict}_`);
      }
    } catch (e) {
      await reply("Couldn't reach your data right now. Try again in a bit.");
    }
  } else if (text === "/start") {
    await reply("Talent without working hard is nothing. Send /today anytime for a straight status check on your day.");
  }

  return res.status(200).json({ ok: true });
};
