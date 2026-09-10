// api/ai.js
// Single AI proxy for JeetOS. Keeps provider API keys server-side (Vercel env
// vars) instead of shipping them in the client bundle. The client posts
// { system, messages, max, provider? } and gets back { text, provider }.
//
// Tries providers in order, skipping any whose env var isn't set, and
// falling through to the next one on failure — so the app keeps working
// even if only one key is configured.
//
// Claude is tried first by default (the coaches are meant to be answered by
// Claude) — set ANTHROPIC_API_KEY in Vercel → Settings → Environment
// Variables. GROQ_API_KEY / GEMINI_API_KEY are optional fallbacks used only
// if the Claude call fails or ANTHROPIC_API_KEY isn't set.

const PROVIDER_ORDER = ["claude", "groq", "gemini"];

async function callClaude(system, messages, max) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: max || 1000,
      system,
      messages: messages.map(m => ({ role: m.role, content: String(m.content) })),
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Claude " + r.status + ": " + (d && d.error && d.error.message || r.status));
  const text = d && d.content && d.content[0] && d.content[0].text;
  if (!text) throw new Error("Claude: empty response");
  return text;
}

async function callGroq(system, messages, max) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not configured");
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: max || 800,
      temperature: 0.85,
      messages: [{ role: "system", content: system }, ...messages.map(m => ({ role: m.role, content: String(m.content) }))],
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Groq " + r.status + ": " + (d && d.error && d.error.message || r.status));
  const text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if (!text) throw new Error("Groq: empty response");
  return text;
}

async function callGemini(system, messages, max) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not configured");
  const history = messages.slice(0, -1).map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content) }],
  }));
  const last = messages[messages.length - 1];
  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + key,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [...history, { role: "user", parts: [{ text: String(last.content) }] }],
        generationConfig: { maxOutputTokens: max || 1000, temperature: 0.85 },
      }),
    }
  );
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Gemini " + r.status + ": " + (d && d.error && d.error.message || r.status));
  const text = d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0] && d.candidates[0].content.parts[0].text;
  if (!text) throw new Error("Gemini: empty response");
  return text;
}

const CALLERS = { claude: callClaude, groq: callGroq, gemini: callGemini };

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { system, messages, max, provider } = req.body || {};
  if (!system || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "system and messages[] are required" });
  }

  const order = provider && CALLERS[provider]
    ? [provider, ...PROVIDER_ORDER.filter(p => p !== provider)]
    : PROVIDER_ORDER;

  let lastErr = null;
  for (const p of order) {
    try {
      const text = await CALLERS[p](system, messages, max);
      return res.status(200).json({ text, provider: p });
    } catch (e) {
      lastErr = e;
    }
  }
  return res.status(502).json({ error: (lastErr && lastErr.message) || "No AI provider configured" });
};
