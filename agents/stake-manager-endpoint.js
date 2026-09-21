// api/stake-manager.js
// Executes the financial stake system. Called AFTER api/psychologist.js
// has already returned a verdict — this endpoint never decides
// waive-or-charge itself, it only enforces whatever verdict it's given,
// against the stake config and weekly cap, and logs the ledger entry.
//
// POST body: { task: string, verdict: "waive"|"charge", date?, reasonCategory? }
// Returns: { charged, amount, weeklyTotal, weeklyCap, cappedOut, waiveRateFlag }
//
// Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or
// SUPABASE_ANON_KEY), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (for the
// charge notification — optional, charge still logs without them),
// STAKE_WEEKLY_CAP (optional, defaults to 1000)

function supaHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  return { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
}

async function getStakeConfig(SUPABASE_URL, task) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/jeetos_stake_config?task=eq.${encodeURIComponent(task)}&active=eq.true&select=*`,
    { headers: supaHeaders() }
  );
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function getWeeklyCharged(SUPABASE_URL) {
  const startOfWeek = new Date();
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
  const since = startOfWeek.toISOString().slice(0, 10);
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/jeetos_stake_ledger?date=gte.${since}&waived=eq.false&select=amount`,
    { headers: supaHeaders() }
  );
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) ? rows.reduce((s, r) => s + Number(r.amount || 0), 0) : 0;
}

async function writeLedger(SUPABASE_URL, entry) {
  await fetch(`${SUPABASE_URL}/rest/v1/jeetos_stake_ledger`, {
    method: "POST",
    headers: { ...supaHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify(entry),
  });
}

async function checkWaiveRate(SUPABASE_URL, task) {
  const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/jeetos_stake_ledger?task=eq.${encodeURIComponent(task)}&date=gte.${since}&select=waived`,
    { headers: supaHeaders() }
  );
  const rows = await r.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length < 2) return false;
  const waivedCount = rows.filter((r) => r.waived).length;
  return waivedCount / rows.length > 0.5;
}

async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  }).catch(() => {});
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { task, verdict, date, reasonCategory } = req.body || {};
  if (!task || !verdict) {
    return res.status(400).json({ error: "task and verdict are required" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  if (!SUPABASE_URL) return res.status(500).json({ error: "SUPABASE_URL not configured" });

  const today = date || new Date().toISOString().slice(0, 10);

  const config = await getStakeConfig(SUPABASE_URL, task).catch(() => null);
  if (!config) {
    // This task isn't staked at all — valid no-op, not an error
    return res.status(200).json({ charged: false, reason: "task not staked" });
  }

  const isWaive = verdict === "waive";
  const baseAmount = isWaive ? 0 : Number(config.amount || 50);

  let weeklyTotal = 0;
  let cappedOut = false;
  const cap = Number(process.env.STAKE_WEEKLY_CAP || 1000);

  if (!isWaive) {
    weeklyTotal = await getWeeklyCharged(SUPABASE_URL).catch(() => 0);
    if (weeklyTotal + baseAmount > cap) {
      cappedOut = true;
    }
  }

  const finalAmount = cappedOut ? 0 : baseAmount;

  await writeLedger(SUPABASE_URL, {
    task,
    date: today,
    amount: finalAmount,
    waived: isWaive || cappedOut,
    reason: reasonCategory || null,
  }).catch(() => {});

  if (!isWaive && !cappedOut) {
    await notifyTelegram(
      `💸 *Stake charged:* ₹${finalAmount}\n` +
        `Task: ${task} — ${today}\n\n` +
        `Weekly total: ₹${weeklyTotal + finalAmount} / ₹${cap} cap`
    );
  }

  const waiveRateFlag = await checkWaiveRate(SUPABASE_URL, task).catch(() => false);

  return res.status(200).json({
    charged: !isWaive && !cappedOut,
    amount: finalAmount,
    weeklyTotal: weeklyTotal + finalAmount,
    weeklyCap: cap,
    cappedOut,
    waiveRateFlag,
  });
};
