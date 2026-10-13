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
// Claude) — set ANTHROPIC_API_KEY (or CLAUDE_KEY) in Vercel → Settings →
// Environment Variables. GROQ_API_KEY / GEMINI_API_KEY are optional
// fallbacks used only if the Claude call fails or no Claude key is set.

const PROVIDER_ORDER = ["claude", "groq", "gemini"];

async function callClaude(system, messages, max) {
  const key = (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_KEY || "").trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY (or CLAUDE_KEY) not configured");
  // A pasted curl command or stray text instead of the bare key makes fetch
  // throw with the whole header value in its message — catch that up front.
  if (!/^sk-ant-[\w-]+$/.test(key)) throw new Error("ANTHROPIC_API_KEY is malformed: paste only the sk-ant-... key, nothing else");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      // Short coach chats don't need deep reasoning; low effort keeps them fast and cheap.
      output_config: { effort: "low" },
      // Headroom for adaptive thinking on top of the reply itself.
      max_tokens: Math.max(max || 1000, 2000),
      system,
      messages: messages.map(m => ({ role: m.role, content: String(m.content) })),
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Claude " + r.status + ": " + (d && d.error && d.error.message || r.status));
  // Claude thinks adaptively by default, so content[0] can be a
  // thinking block — read the first text block instead.
  const block = d && Array.isArray(d.content) && d.content.find(b => b.type === "text" && b.text);
  const text = block && block.text;
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

// Error text is sent to the browser and shown in the app, so never let a key
// that ended up inside an error message travel with it.
function redact(msg) {
  return String(msg || "").replace(/(sk-|gsk_|AIza)[\w-]{6,}/g, "$1***");
}

module.exports = async function handler(req, res) {
  // GET /api/ai is a setup check you can open in a browser: it reports which
  // provider keys this deployment can see (never the keys themselves) and
  // whether a one-word Claude call actually succeeds.
  if (req.method === "GET") {
    const status = {
      claudeKey: !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_KEY),
      groqKey: !!process.env.GROQ_API_KEY,
      geminiKey: !!process.env.GEMINI_API_KEY,
    };
    if (status.claudeKey) {
      try {
        await callClaude("Reply with one word.", [{ role: "user", content: "ping" }], 50);
        status.claude = "ok";
      } catch (e) {
        status.claude = redact(e.message);
      }
    }
    return res.status(200).json(status);
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { system, max, provider } = req.body || {};
  let { messages } = req.body || {};
  if (!system || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "system and messages[] are required" });
  }
  // Coaches can send several texts in a row (and text first), so the chat can
  // hold consecutive assistant messages — fold same-role runs into one turn.
  messages = messages.reduce((out, m) => {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = String(last.content) + "\n\n" + String(m.content);
    else out.push({ role: m.role, content: String(m.content) });
    return out;
  }, []);
  if (messages[0].role !== "user") messages.unshift({ role: "user", content: "(Jeet opened the chat)" });

  const order = provider && CALLERS[provider]
    ? [provider, ...PROVIDER_ORDER.filter(p => p !== provider)]
    : PROVIDER_ORDER;

  const errors = [];
  for (const p of order) {
    try {
      const text = await CALLERS[p](system, messages, max);
      return res.status(200).json({ text, provider: p });
    } catch (e) {
      errors.push(redact(e.message));
    }
  }
  // Report every provider's failure, not just the last one — the first
  // (Claude) error is usually the one that matters.
  return res.status(502).json({ error: errors.join(" | ") || "No AI provider configured" });
};
