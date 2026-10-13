// api/coach-nudge.js
// Coaches text first. Vercel Cron hits this at fixed times of day
// (?slot=morning|afternoon|evening|night, see vercel.json). Each slot picks
// the coach who'd naturally reach out right then, writes one short message
// in their voice using today's log, the shared team memory and open
// commitments, saves it to jeetos_coach_inbox (the app shows it as an unread
// message from that coach) and also sends it to Telegram when configured.
// One message per coach per slot per day — re-runs are no-ops. On Sundays
// (?slot=review) every coach with an active goal sends a 2-line weekly review.

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

function agoText(iso, today) {
  const days = Math.round((new Date(today) - new Date(iso)) / 86400000);
  if (!isFinite(days) || days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return days + " days ago";
  if (days < 60) return Math.round(days / 7) + " weeks ago";
  return Math.round(days / 30) + " months ago";
}
function goalText(g, today) {
  const u = g.unit ? " " + g.unit : "";
  const hist = (g.history || []).slice(-4).map(h => `${h.v}${u} (${agoText(h.d, today)})`).join(" → ");
  return `"${g.text}"` + (g.target != null ? `: started ${g.start_value}${u}, now ${g.current_value}${u}, target ${g.target}${u}` : "")
    + (g.deadline ? `, by ${g.deadline}` : "") + (hist ? `. Log: ${hist}` : "");
}
function logLine(log) {
  return `gym ${log.gym_done ? "done" : "not done"}, skincare ${log.skincare_done ? "done" : "not done"}, sleep ${log.sleep_hours}h, protein ${log.total_protein}g, water ${log.water} glasses, mood ${log.mood}/5, energy ${log.energy}/5`;
}

async function sendTelegram(coachId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return "not configured";
  try {
    const t = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `${COACHES[coachId].name}: ${text}` }),
    });
    return (await t.json()).ok ? "sent" : "failed";
  } catch (_) { return "failed"; }
}

// Writes one text in a coach's voice, saves it to the inbox (once per coach
// per slot per day) and forwards it to Telegram.
async function writeAndSend(coachId, slot, task, shared) {
  const { today, memory, commitments, goals, moments } = shared;
  const recent = await supaJson(`jeetos_coach_inbox?coach=eq.${coachId}&select=text,created_on&order=created_at.desc&limit=5`);
  const mine = commitments.filter(c => c.coach === coachId);
  const myGoals = goals.filter(g => g.coach === coachId);
  const myMoments = moments.filter(m => m.coach === coachId).slice(-8);
  const nick = [...myMoments].reverse().find(m => m.kind === "nickname");
  const system = `${personaPrompt(coachId)}

${task}
Sound like a person, not a notification: no "Reminder:", no lists, no greetings like "Hello Jeet!". Hinglish like he talks. Never mention being an AI, apps, data or memory.${coachId === "mind" ? " You're gently checking in — warm, no pressure, no advice dump." : ""}

What the coaching team knows about him: ${memory.length ? memory.map(m => m.fact).join("; ") : "nothing yet"}.
His open promises${mine.length ? " to you" : ""}: ${(mine.length ? mine : commitments).map(c => `"${c.text}" (check on ${c.due})`).join("; ") || "none"}.
Your goal${myGoals.length === 1 ? "" : "s"} with him: ${myGoals.map(g => goalText(g, today)).join("; ") || "none yet"}.
${nick ? `Your nickname for him: "${nick.text}" (use it if it fits).\n` : ""}Things that happened between you two: ${myMoments.map(m => `(${agoText(m.created_on, today)}) ${m.text}`).join("; ") || "nothing special yet"}.
Your last few texts to him (don't repeat these): ${recent.map(r => r.text).join(" | ") || "none"}.`;

  const text = await callClaude(system, "Write the text now. Only the message itself.");
  // Save first; the unique (coach, slot, created_on) key makes cron retries no-ops.
  const ins = await supa("jeetos_coach_inbox?on_conflict=coach,slot,created_on", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ coach: coachId, slot, text, created_on: today }),
  }).catch(() => null);
  const inserted = ins && ins.ok ? await ins.json().catch(() => []) : [];
  if (!inserted.length) return { coach: coachId, skipped: "already sent for this slot today" };
  return { coach: coachId, slot, text, telegram: await sendTelegram(coachId, text) };
}

module.exports = async function handler(req, res) {
  const auth = req.headers["authorization"];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const slot = (req.query && req.query.slot) || "evening";
  if (!SLOT_MOMENT[slot] && slot !== "review") return res.status(400).json({ error: "slot must be morning|afternoon|evening|night|review" });

  const today = istIsoDate();
  const [logs, memory, commitments, goals, moments] = await Promise.all([
    supaJson(`jeetos_logs?date=eq.${encodeURIComponent(istDateString())}&select=*`),
    supaJson("jeetos_team_memory?select=fact&order=created_at.asc&limit=60"),
    supaJson("jeetos_commitments?status=eq.open&select=id,coach,text,due&order=due.asc&limit=20"),
    supaJson("jeetos_coach_goals?status=eq.active&select=coach,text,unit,start_value,target,current_value,deadline,history&order=created_at.asc&limit=20"),
    supaJson("jeetos_coach_moments?select=coach,kind,text,created_on&order=created_at.asc&limit=120"),
  ]);
  const shared = { today, memory, commitments, goals, moments };

  try {
    // Sunday review: every coach with an active goal sends a 2-line weekly review.
    if (slot === "review") {
      const days = Array.from({ length: 7 }, (_, i) => istDateString(new Date(istNow().getTime() - i * 86400000)));
      const week = await supaJson(`jeetos_logs?date=in.(${days.map(d => encodeURIComponent(`"${d}"`)).join(",")})&select=*`);
      const weekText = week.length ? week.map(l => `${l.date}: ${logLine(l)}`).join("\n") : "barely anything logged this week";
      const coaches = [...new Set(goals.map(g => g.coach))].filter(c => COACHES[c]).slice(0, 4);
      if (!coaches.length) coaches.push("fitness", "nutrition");
      const results = [];
      for (const c of coaches) {
        results.push(await writeAndSend(c, "review",
          `It's Sunday — you're sending Jeet your weekly review, like a coach who watched his whole week. Write exactly 2 short lines: what went well (specific), and the one thing to focus on next week. If you have a goal with him, say where he stands on it vs the start. End by telling him to do his weekly photo check-in in the app (face, hair, body, outfit) so the whole team can review his week properly.\n\nHis week:\n${weekText}`, shared));
      }
      return res.status(200).json({ slot, results });
    }

    const log = logs[0] || null;
    const coachId = (req.query && COACHES[req.query.coach] && req.query.coach) || pickCoach(slot, log, commitments);
    const result = await writeAndSend(coachId, slot,
      `You're texting Jeet on WhatsApp first, unprompted — like a real coach who thought of him. ${SLOT_MOMENT[slot]}
Write ONE short text (1-2 lines). Reference one specific thing below if it fits naturally (today's log, a promise, your goal with him, something from your history); otherwise just check in about your area. End with something he'd want to reply to.

Today in his log: ${log ? logLine(log) : "nothing logged in the app yet today"}.`, shared);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
