// api/psychologist.js
// First-responder endpoint for JeetOS. Call this whenever a task is marked
// missed and the person gives a reason. It checks Supabase for prior
// history on the same reason, asks Claude to triage using the
// psychologist logic (see /agents/psychologist.md — this file is the
// runtime implementation of those rules), and writes the result back to
// jeetos_excuse_log so tomorrow's check-in remembers today's conversation.
//
// POST body: { task: string, reasonGiven: string, date?: "YYYY-MM-DD" }
// Returns: { verdict: "waive"|"charge", message, solution, reasonCategory,
//            repeatCount, isRepeat }
//
// Requires env vars: ANTHROPIC_API_KEY (or CLAUDE_KEY), SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)

const PSYCHOLOGIST_SYSTEM = `
You are the psychologist agent inside JeetOS, a personal discipline/habit
tracker for Jeet (solo founder of Luxella, BBA Finance student, tracks
gym, skincare, nutrition, sleep daily).

Core principle: every missed task is a symptom, not the problem. You are
the FIRST RESPONDER whenever a task is missed — before any domain coach,
before any financial stake is charged.

You will be given the task that was missed, the reason given today, and
(if any) the person's history of past reasons for the SAME task in the
last 14 days.

Your job, in order:
1. Classify today's reason into a short reason_category (e.g.
   "motivation / morning-resistance", "stress", "logistics", "health",
   "overwhelm", "forgot", "other")
2. Check the provided history: is there a prior entry with the SAME
   reason_category where a solution was offered?
3. If NO matching history (first time this category appears):
   - Respond warmly and briefly in Hinglish, like a friend, not a bot
   - Offer exactly ONE concrete, specific, testable solution tailored to
     this exact reason — never generic advice
   - verdict = "waive"
4. If there IS matching history:
   - Reference the specific prior solution_offered by name in your
     message, and ask whether they actually tried it
   - Read their current message/reason text carefully for whether they
     are indicating they tried the fix or not
   - If it sounds like they tried it and it still didn't fully work:
     verdict = "waive", offer a DIFFERENT solution than before
   - If it sounds like they did NOT try the prior solution: verdict =
     "charge" — name this plainly but without shame, still offer to try
     the solution today
   - When genuinely ambiguous whether they tried it, ask one direct
     question in your message and default verdict to "waive" for this
     turn (never charge on ambiguity — only charge on a clear signal)
5. Watch for correlation with known stress sources (Luxella business
   pressure, NMIMS exam weeks) mentioned in the reason — if present, lean
   toward "waive" even on a repeat.

Respond ONLY with strict JSON, no markdown fencing, no commentary outside
the JSON, in exactly this shape:
{
  "reason_category": string,
  "verdict": "waive" | "charge",
  "message": string,
  "solution_offered": string,
  "is_repeat": boolean
}
`.trim();

async function callClaude(system, userPrompt) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY (or CLAUDE_KEY) not configured");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 600,
      system,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Claude " + r.status + ": " + ((d && d.error && d.error.message) || r.status));
  const text = d && d.content && d.content[0] && d.content[0].text;
  if (!text) throw new Error("Claude: empty response");
  return text;
}

function supaHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  return { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
}

async function fetchHistory(SUPABASE_URL, task) {
  const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/jeetos_excuse_log?task=eq.${encodeURIComponent(task)}&date=gte.${since}&order=date.desc&limit=10`,
    { headers: supaHeaders() }
  );
  if (!r.ok) return [];
  return await r.json().catch(() => []);
}

async function writeExcuseLog(SUPABASE_URL, entry) {
  await fetch(`${SUPABASE_URL}/rest/v1/jeetos_excuse_log`, {
    method: "POST",
    headers: { ...supaHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify(entry),
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { task, reasonGiven, date } = req.body || {};
  if (!task || !reasonGiven) {
    return res.status(400).json({ error: "task and reasonGiven are required" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  if (!SUPABASE_URL) return res.status(500).json({ error: "SUPABASE_URL not configured" });

  const today = date || new Date().toISOString().slice(0, 10);

  let history = [];
  try {
    history = await fetchHistory(SUPABASE_URL, task);
  } catch (e) {
    history = [];
  }

  const historyText = history.length
    ? history
        .map(
          (h) =>
            `- ${h.date}: reason="${h.reason_given}" category="${h.reason_category}" ` +
            `solution_offered="${h.solution_offered}" solution_applied=${h.solution_applied}`
        )
        .join("\n")
    : "No prior history for this task in the last 14 days.";

  const userPrompt =
    `Task missed: ${task}\n` +
    `Reason given today: "${reasonGiven}"\n\n` +
    `Prior history for this task (last 14 days):\n${historyText}`;

  let parsed;
  try {
    const raw = await callClaude(PSYCHOLOGIST_SYSTEM, userPrompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (e) {
    return res.status(502).json({ error: "Psychologist AI call failed: " + e.message });
  }

  const priorEntry = history.find((h) => h.reason_category === parsed.reason_category);
  const repeatCount = priorEntry ? (priorEntry.repeat_count || 1) + 1 : 1;

  try {
    await writeExcuseLog(SUPABASE_URL, {
      task,
      date: today,
      reason_given: reasonGiven,
      reason_category: parsed.reason_category,
      solution_offered: parsed.solution_offered,
      solution_applied: null,
      repeat_count: repeatCount,
      waived: parsed.verdict === "waive",
      stake_charged: false,
    });
  } catch (e) {
    // Don't fail the whole request if logging fails — the verdict still
    // needs to reach the client so the UI can react
  }

  return res.status(200).json({
    verdict: parsed.verdict,
    message: parsed.message,
    solution: parsed.solution_offered,
    reasonCategory: parsed.reason_category,
    repeatCount,
    isRepeat: !!parsed.is_repeat,
  });
};
