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
const { sendToAll } = require("./_push");

// The jeetos_* tables are open to the app's public key. Env keys are tried
// first, but an old/rotated one answers 401 — then fall back to the public key.
const SUPABASE_URL = "https://qzripzgbstvxkfobzhyv.supabase.co";
const PUBLIC_KEY = "sb_publishable_-EA-q_dacUuWovbrCW5XVw_pPZ2vK_O";
const SUPABASE_KEYS = [...new Set([process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.SUPABASE_ANON_KEY, PUBLIC_KEY].filter(Boolean).map(k => k.trim()))];
async function supa(path, init = {}) {
  let r;
  for (const key of SUPABASE_KEYS) {
    r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, Object.assign({}, init, {
      headers: Object.assign({ apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }, init.headers || {}),
    }));
    if (r.status !== 401) return r;
  }
  return r;
}
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
  // A coach who promised to follow up today gets the slot first.
  const own = commitments.find(c => c.owner === "coach" && c.due <= today && COACHES[c.coach]);
  if (own && slot !== "night") return own.coach;
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
  streak: "It's around 9:15 pm — the last chance today to protect his streak.",
};

// Same models as the chat (api/ai.js): the smart one, then the fast one if it fails.
const MODELS = [...new Set([(process.env.CLAUDE_CHAT_MODEL || "claude-sonnet-5-5").trim(), (process.env.CLAUDE_FAST_MODEL || "claude-haiku-5-5").trim()])];
async function callClaude(system, user) {
  const key = (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_KEY || "").trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");
  let last;
  for (const model of MODELS) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, output_config: { effort: "low" }, max_tokens: 3000, system, messages: [{ role: "user", content: user }] }),
    });
    const d = await r.json().catch(() => ({}));
    const block = r.ok && d.stop_reason !== "refusal" && Array.isArray(d.content) && d.content.find(b => b.type === "text" && b.text);
    if (block) return block.text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim();
    last = new Error("Claude " + r.status + " (" + model + ")");
    if (r.status === 401) break;
  }
  throw last;
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
const PROFILE_LABELS = { about: "who he is", goals: "what he wants", routine: "routine & constraints", preferences: "likes/dislikes", struggles: "what gets in the way", wins: "wins", style: "how to coach him", life: "life & people" };
function profileText(p) {
  if (!p) return "";
  return Object.keys(PROFILE_LABELS).filter(k => Array.isArray(p[k]) && p[k].length).map(k => PROFILE_LABELS[k] + ": " + p[k].map(x => x.t).join("; ")).join(" | ");
}
// null = he didn't enter it (not the same as 0 / skipped).
const shown = (v, u) => (v == null ? "not logged" : v + u);
function logLine(log) {
  return `gym ${log.gym_done ? "done" : "not logged"}, skincare ${log.skincare_done ? "done" : "not ticked"}, sleep ${shown(log.sleep_hours, "h")}, protein ${shown(log.total_protein, "g")}, calories ${shown(log.total_cal, " kcal")}, water ${shown(log.water, " glasses")}, mood ${shown(log.mood, "/5")}, energy ${shown(log.energy, "/5")} ("not logged" means he hasn't entered it yet — never assume he skipped it)`;
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
  const { today, memory, commitments, goals, moments, profile, primary, todayPriority } = shared;
  const since = new Date(Date.now() - 4 * 864e5).toISOString();
  const [recent, past, notes] = await Promise.all([
    supaJson(`jeetos_coach_inbox?coach=eq.${coachId}&select=text,created_on&order=created_at.desc&limit=5`),
    supaJson(`jeetos_convo_summaries?coach=eq.${coachId}&select=summary,to_ts&order=to_ts.desc&limit=4`),
    supaJson(`jeetos_coach_notes?to_coach=in.(${coachId},team)&from_coach=neq.${coachId}&created_at=gte.${encodeURIComponent(since)}&select=from_coach,text&order=created_at.desc&limit=4`),
  ]);
  const his = commitments.filter(c => c.owner !== "coach");
  const mine = his.filter(c => c.coach === coachId);
  // Things this coach promised to do for him that are due now — the text must deliver them.
  const ownDue = commitments.filter(c => c.owner === "coach" && c.coach === coachId && c.due <= today);
  const myGoals = goals.filter(g => g.coach === coachId);
  const myMoments = moments.filter(m => m.coach === coachId).slice(-8);
  const nick = [...myMoments].reverse().find(m => m.kind === "nickname");
  const system = `${personaPrompt(coachId)}

${task}
Sound like a person, not a notification: no "Reminder:", no lists, no greetings like "Hello Jeet!". Hinglish like he talks. Never mention being an AI, apps, data or memory.${coachId === "mind" ? " You're gently checking in — warm, no pressure, no advice dump." : ""}

Who he is (built up from all his chats): ${profileText(profile) || "still getting to know him"}.
What you two talked about before: ${past.map(x => `(${agoText(new Date(+x.to_ts + 330 * 60000).toISOString().slice(0, 10), today)}) ${x.summary}`).join(" | ") || "nothing older yet"}.
Other notes: ${memory.length ? memory.map(m => m.fact).join("; ") : "none"}.
Make the text fit what he wants and his routine — like someone who knows him. Plain everyday Hinglish, no jargon or technical terms. If you point out a problem or ask him to do something, give HIS personal reason in a few words (from his log, promises or history), never a generic one.
His open promises${mine.length ? " to you" : ""}: ${(mine.length ? mine : his).map(c => `"${c.text}" (check on ${c.due})`).join("; ") || "none"}.
${ownDue.length ? `YOU PROMISED HIM, AND IT'S DUE NOW — this text must do it (check it, send it, review it; ask for the one number/photo you need): ${ownDue.map(c => `"${c.text}" (by ${c.due})`).join("; ")}.\n` : ""}
${primary ? `HIS ONE PRIMARY GOAL (the whole team supports it first): ${goalText(primary, today)}.${todayPriority ? ` Today's one priority: "${todayPriority.text}" — ${todayPriority.done ? "done" : "not done yet"}.` : ""} Tie your text to it when it fits; don't push a competing new project.\n` : ""}Your goal${myGoals.length === 1 ? "" : "s"} with him: ${myGoals.map(g => goalText(g, today)).join("; ") || "none yet"}.
${nick ? `Your nickname for him: "${nick.text}" (use it if it fits).\n` : ""}Things that happened between you two: ${myMoments.map(m => `(${agoText(m.created_on, today)}) ${m.text}`).join("; ") || "nothing special yet"}.
${notes.length ? `Your teammates told you privately (act on it, you can mention them by name): ${notes.map(n => `${(COACHES[n.from_coach] && COACHES[n.from_coach].name) || n.from_coach}: ${n.text}`).join(" | ")}.\n` : ""}Your last few texts to him (don't repeat these): ${recent.map(r => r.text).join(" | ") || "none"}.`;

  const text = await callClaude(system, "Write the text now. Only the message itself.");
  // Save first; the unique (coach, slot, created_on) key makes cron retries no-ops.
  const ins = await supa("jeetos_coach_inbox?on_conflict=coach,slot,created_on", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ coach: coachId, slot, text, created_on: today }),
  }).catch(() => null);
  const inserted = ins && ins.ok ? await ins.json().catch(() => []) : [];
  if (!inserted.length) return { coach: coachId, skipped: "already sent for this slot today" };
  // The coach kept their word — close those promises.
  for (const c of ownDue) {
    await supa(`jeetos_commitments?id=eq.${encodeURIComponent(c.id)}`, { method: "PATCH", body: JSON.stringify({ status: "done", resolved_at: new Date().toISOString() }) }).catch(() => null);
  }
  // iPhone push: the coach's text lands on his lock screen; tapping opens that chat.
  const push = await sendToAll(supa, { title: (COACHES[coachId] && COACHES[coachId].name) || "JeetOS", body: text.replace(/\s+/g, " ").slice(0, 180), url: "/?chat=" + coachId, tag: coachId + "-" + slot }).catch(e => ({ error: e.message }));
  return { coach: coachId, slot, text, telegram: await sendTelegram(coachId, text), push };
}

module.exports = async function handler(req, res) {
  const auth = req.headers["authorization"];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const slot = (req.query && req.query.slot) || "evening";
  if (!SLOT_MOMENT[slot] && slot !== "review") return res.status(400).json({ error: "slot must be morning|afternoon|evening|night|streak|review" });

  const today = istIsoDate();
  const [logs, memory, commitments, goals, moments, profileRows, goalState] = await Promise.all([
    supaJson(`jeetos_logs?date=eq.${encodeURIComponent(istDateString())}&select=*`),
    supaJson("jeetos_team_memory?select=fact&order=created_at.asc&limit=60"),
    supaJson("jeetos_commitments?status=eq.open&select=id,coach,text,due,owner&order=due.asc&limit=30"),
    supaJson("jeetos_coach_goals?status=eq.active&select=id,focus,coach,text,unit,start_value,target,current_value,deadline,history&order=created_at.asc&limit=20"),
    supaJson("jeetos_coach_moments?select=coach,kind,text,created_on&order=created_at.asc&limit=120"),
    supaJson("jeetos_profile?id=eq.jeet&select=data"),
    supaJson("jeetos_goal_state?id=eq.jeet&select=data"),
  ]);
  const gs = goalState[0] && goalState[0].data;
  const primary = gs && gs.goalId ? goals.find(g => g.id === gs.goalId) || null : null;
  const shared = { today, memory, commitments, goals, moments, profile: profileRows[0] && profileRows[0].data, primary, todayPriority: gs && gs.today && gs.today.date === today ? gs.today : null };

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
    // Gone quiet 3+ days → a no-blame check-in instead of the usual nudge (morning only).
    if (slot === "morning" && !(req.query && req.query.coach)) {
      const last = await supaJson("jeetos_logs?select=updated_at&order=updated_at.desc&limit=1");
      const quietDays = last[0] && last[0].updated_at ? Math.floor((Date.now() - Date.parse(last[0].updated_at)) / 864e5) : null;
      if (quietDays != null && quietDays >= 3) {
        const result = await writeAndSend(quietDays >= 7 ? "mind" : "ronaldo", "morning",
          `You're texting Jeet first. Nothing has been logged in the app for ${quietDays} days. Treat it as missing data, not failure — you don't know what happened. Warmly ask how things have been (exams? travel? low phase?), no blame, no list of what he missed, no lecture. One or two short lines, and make it easy to reply.`, shared);
        return res.status(200).json(Object.assign({ quietDays }, result));
      }
    }
    // Streak rescue: only if something is actually at risk and he hasn't marked a minimum/recovery.
    if (slot === "streak") {
      const marks = await supaJson(`jeetos_streak_marks?date=eq.${today}&select=habit,kind`);
      const marked = new Set(marks.map(m => m.habit));
      const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][istNow().getUTCDay()];
      const risks = [];
      if (!(log && log.gym_done) && weekday !== "Sunday" && !marked.has("move")) risks.push({ coach: "fitness", habit: "workout", min: "a 20 min home workout or a brisk 30 min walk" });
      if ((!log || (+log.total_protein || 0) < 100) && !marked.has("food")) risks.push({ coach: "nutrition", habit: "protein", min: "getting to 100g protein (e.g. a whey scoop + a bowl of curd or soya)" });
      if (!risks.length) return res.status(200).json({ slot, skipped: "streak safe or already marked" });
      const r = risks[0];
      const result = await writeAndSend(r.coach, "streak",
        `You're texting Jeet to protect his streak. It's about 9:15 pm and his ${r.habit} isn't logged today. Offer the minimum version — ${r.min} — as the way to keep the streak tonight, make it feel doable right now, and ask him to mark it in the app (Today → streak card) when done. If he's sick, injured or in pain, tell him to mark a recovery day instead — never push through pain. 1-2 short lines, warm but firm, no guilt.

Today in his log: ${log ? logLine(log) : "nothing logged in the app yet today"}.`, shared);
      return res.status(200).json(result);
    }
    let coachId = (req.query && COACHES[req.query.coach] && req.query.coach) || pickCoach(slot, log, commitments);
    // Repeated misses with one coach → that coach does a bottleneck check instead of another reminder.
    let missNote = "";
    if (!(req.query && req.query.coach) && (slot === "afternoon" || slot === "evening")) {
      const weekAgo = istIsoDate(new Date(istNow().getTime() - 7 * 864e5));
      const missed = await supaJson(`jeetos_commitments?status=eq.missed&owner=neq.coach&due=gte.${weekAgo}&select=coach,text,blocker`);
      const by = {};
      missed.forEach(m => { if (COACHES[m.coach]) (by[m.coach] = by[m.coach] || []).push(m); });
      const top = Object.keys(by).sort((a, b) => by[b].length - by[a].length)[0];
      if (top && by[top].length >= 2) {
        coachId = top;
        missNote = `\nHe has missed ${by[top].length} promises with you this week: ${by[top].map(m => `"${m.text}"${m.blocker ? ` (blocker: ${m.blocker})` : ""}`).join("; ")}. Don't send another reminder or pep talk. Without judgement, ask what's REALLY getting in the way, and offer one smaller or different strategy — thank him for being honest if he tells you.`;
      }
    }
    const result = await writeAndSend(coachId, slot,
      `You're texting Jeet on WhatsApp first, unprompted — like a real coach who thought of him. ${SLOT_MOMENT[slot]}
Write ONE short text (1-2 lines). Reference one specific thing below if it fits naturally (today's log, a promise, your goal with him, something from your history); otherwise just check in about your area. End with something he'd want to reply to.

Today in his log: ${log ? logLine(log) : "nothing logged in the app yet today"}.${missNote}`, shared);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
