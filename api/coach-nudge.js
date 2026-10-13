// api/coach-nudge.js
// Coaches text first. Vercel Cron hits this at fixed times of day
// (?slot=morning|afternoon|evening|night, see vercel.json). Each slot picks
// the coach who'd naturally reach out right then, writes one short message
// in their voice using today's log, the shared team memory and open
// commitments, saves it to jeetos_coach_inbox (the app shows it as an unread
// message from that coach) and also sends it to Telegram when configured.
// One message per coach per slot per day — re-runs are no-ops.

const { COACHES, personaPrompt } = require("./_coach-personas");

// Same public project/key the app already uses; env vars override.
const SUPABASE_URL = process.env.SUPABASE_URL || "https://qzripzgbstvxkfobzhyv.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "sb_publishable_-EA-q_dacUuWovbrCW5XVw_pPZ2vK_O";
const supa = (path, init = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, Object.assign({}, init, {
  headers: Object.assign({ apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" }, init.headers || {}),
}));
async function supaJson(path) {
  try { const r = await supa(path); const d = await r.json(); return Array.isArray(d) ? d : []; } catch (_) { return []; }
}

// Jeet is in India: everything is keyed on IST.
function istNow() { return new Date(Date.now() + 330 * 60000); }
function istIsoDate(d = istNow()) { return d.toISOString().slice(0, 10); }
function istDateString(d = istNow()) {
  // Matches the app's new Date().toDateString() keys in jeetos_logs, e.g. "Tue Oct 13 2026".
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")} ${d.getUTCFullYear()}`;
}

function pickCoach(slot, log, commitments) {
  const now = istNow();
  const day = now.getUTCDate();
  const today = istIsoDate(now);
  if (slot === "morning") return day % 2 ? "skin" : "nutrition";
  if (slot === "afternoon") {
    const due = commitments.find(c => c.due <= today);
    if (due && COACHES[due.coach]) return due.coach;
    return ["style", "hair", "grooming", "ronaldo"][day % 4];
  }
  if (slot === "evening") {
    const sunday = now.getUTCDay() === 0;
    if (!sunday && !(log && log.gym_done)) return "fitness";
    return day % 2 ? "ronaldo" : "style";
  }
  // night: Dr. Meher checks in when mood has been low, otherwise Dr. Sam's wind-down.
  if (log && log.mood && Number(log.mood) <= 2) return "mind";
  return "sleep";
}

const SLOT_MOMENT = {
  morning: "It's morning (around 8 am).",
  afternoon: "It's early afternoon (around 1:45 pm).",
  evening: "It's evening (around 5 pm), usual gym time.",
  night: "It's night (around 10:30 pm), close to his bedtime.",
};

async function callClaude(system, user) {
  const key = (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_KEY || "").trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-5-5", output_config: { effort: "low" }, max_tokens: 1000, system, messages: [{ role: "user", content: user }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Claude " + r.status);
  const block = Array.isArray(d.content) && d.content.find(b => b.type === "text" && b.text);
  if (!block) throw new Error("Claude: empty response");
  return block.text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim();
}

module.exports = async function handler(req, res) {
  const auth = req.headers["authorization"];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const slot = (req.query && req.query.slot) || "evening";
  if (!SLOT_MOMENT[slot]) return res.status(400).json({ error: "slot must be morning|afternoon|evening|night" });

  const today = istIsoDate();
  const [logs, memory, commitments] = await Promise.all([
    supaJson(`jeetos_logs?date=eq.${encodeURIComponent(istDateString())}&select=*`),
    supaJson("jeetos_team_memory?select=fact&order=created_at.asc&limit=60"),
    supaJson("jeetos_commitments?status=eq.open&select=id,coach,text,due&order=due.asc&limit=20"),
  ]);
  const log = logs[0] || null;
  const coachId = (req.query && COACHES[req.query.coach] && req.query.coach) || pickCoach(slot, log, commitments);
  const recent = await supaJson(`jeetos_coach_inbox?coach=eq.${coachId}&select=text,created_on&order=created_at.desc&limit=5`);

  const logText = log
    ? `gym ${log.gym_done ? "done" : "not done yet"}, skincare ${log.skincare_done ? "done" : "not done"}, sleep ${log.sleep_hours}h, protein ${log.total_protein}g, water ${log.water} glasses, mood ${log.mood}/5, energy ${log.energy}/5`
    : "nothing logged in the app yet today";
  const mine = commitments.filter(c => c.coach === coachId);
  const system = `${personaPrompt(coachId)}

You're texting Jeet on WhatsApp first, unprompted — like a real coach who thought of him. ${SLOT_MOMENT[slot]}
Write ONE short text (1-2 lines, Hinglish like he talks). Sound like a person, not a notification: no "Reminder:", no lists, no greetings like "Hello Jeet!". Reference one specific thing below if it fits naturally; otherwise just check in about your area. End with something he'd want to reply to. Never mention being an AI, apps, data or memory.${coachId === "mind" ? " You're gently checking in because he's seemed low — warm, no pressure, no advice dump." : ""}

Today in his log: ${logText}.
What the coaching team knows about him: ${memory.length ? memory.map(m => m.fact).join("; ") : "nothing yet"}.
His open promises${mine.length ? " to you" : ""}: ${(mine.length ? mine : commitments).map(c => `"${c.text}" (check on ${c.due})`).join("; ") || "none"}.
Your last few texts to him (don't repeat these): ${recent.map(r => r.text).join(" | ") || "none"}.`;

  let text;
  try {
    text = await callClaude(system, "Write the text now. Only the message itself.");
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  // Save first; the unique (coach, slot, created_on) key makes cron retries no-ops.
  const ins = await supa("jeetos_coach_inbox?on_conflict=coach,slot,created_on", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ coach: coachId, slot, text, created_on: today }),
  }).catch(() => null);
  const inserted = ins && ins.ok ? await ins.json().catch(() => []) : [];
  if (!inserted.length) return res.status(200).json({ skipped: "already sent for this slot today", coach: coachId });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  let telegram = "not configured";
  if (token && chatId) {
    try {
      const t = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: `${COACHES[coachId].name}: ${text}` }),
      });
      telegram = (await t.json()).ok ? "sent" : "failed";
    } catch (_) { telegram = "failed"; }
  }
  return res.status(200).json({ coach: coachId, slot, text, telegram });
};
