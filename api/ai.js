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

// Three Claude tiers. "pro" (the strongest model) handles real coaching
// questions, assessments, photo scans and check-in reviews; "smart" answers
// casual chat and the group; "fast" is the cheap model for everything else.
// Each falls back to the next one down if it fails. Override with
// CLAUDE_PRO_MODEL / CLAUDE_CHAT_MODEL / CLAUDE_FAST_MODEL.
const PRO_MODEL = (process.env.CLAUDE_PRO_MODEL || "claude-opus-5-5").trim();
const SMART_MODEL = (process.env.CLAUDE_CHAT_MODEL || "claude-sonnet-5-5").trim();
const FAST_MODEL = (process.env.CLAUDE_FAST_MODEL || "claude-haiku-5-5").trim();
const EFFORTS = ["low", "medium", "high"];
// The app puts the part of the system prompt that never changes before this
// marker, so it can be cached and only the live part is billed in full.
const LIVE_MARKER = "\n\n<<<LIVE>>>\n\n";

// A message can carry one photo as a data URL (the app downsizes it first).
function parseImage(image) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ""));
  return m ? { mediaType: m[1], data: m[2] } : null;
}
const NO_PHOTO_NOTE = "(He attached a photo, but you can't see it right now — ask him to describe it.)";

async function callClaude(system, messages, max, opts) {
  opts = opts || {};
  const model = opts.model || FAST_MODEL;
  const key = (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_KEY || "").trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY (or CLAUDE_KEY) not configured");
  // A pasted curl command or stray text instead of the bare key makes fetch
  // throw with the whole header value in its message — catch that up front.
  if (!/^sk-ant-[\w-]+$/.test(key)) throw new Error("ANTHROPIC_API_KEY is malformed: paste only the sk-ant-... key, nothing else");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: Object.assign({
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    }, model === "claude-sonnet-5-5" ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
    body: JSON.stringify(Object.assign({
      model,
      output_config: { effort: EFFORTS.includes(opts.effort) ? opts.effort : (model === FAST_MODEL ? "medium" : "low") },
      // Headroom for adaptive thinking on top of the reply itself.
      max_tokens: Math.max(max || 1000, 4000),
      system: systemBlocks(system),
      messages: messages.map(m => {
        const imgs = (m.images || (m.image ? [m.image] : [])).map(parseImage).filter(Boolean);
        if (!imgs.length) return { role: m.role, content: String(m.content) };
        return { role: m.role, content: [
          ...imgs.map(img => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })),
          { type: "text", text: String(m.content) },
        ] };
      }),
    // If Sonnet's safety filter declines a harmless coaching message, let the API reroute it.
    }, model === "claude-sonnet-5-5" ? { fallbacks: "default" } : {})),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Claude " + r.status + ": " + (d && d.error && d.error.message || r.status));
  // Claude thinks adaptively by default, so content[0] can be a
  // thinking block — read the first text block instead.
  if (d && d.stop_reason === "refusal") throw new Error("Claude declined (" + model + ")");
  const block = d && Array.isArray(d.content) && d.content.find(b => b.type === "text" && b.text);
  const text = block && block.text;
  if (!text) throw new Error("Claude: empty response");
  return text;
}

function systemBlocks(system) {
  const s = String(system || "");
  const i = s.indexOf(LIVE_MARKER);
  if (i < 0) return s;
  return [
    { type: "text", text: s.slice(0, i), cache_control: { type: "ephemeral" } },
    { type: "text", text: s.slice(i + LIVE_MARKER.length) },
  ];
}
function plainSystem(system) { return String(system || "").replace(LIVE_MARKER, "\n\n"); }

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
      messages: [{ role: "system", content: plainSystem(system) }, ...messages.map(m => ({ role: m.role, content: String(m.content) + (m.image || m.images ? "\n" + NO_PHOTO_NOTE : "") }))],
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
  const lastImgs = (last.images || (last.image ? [last.image] : [])).map(parseImage).filter(Boolean);
  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + key,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: plainSystem(system) }] },
        contents: [...history, { role: "user", parts: [
          ...lastImgs.map(img => ({ inline_data: { mime_type: img.mediaType, data: img.data } })),
          { text: String(last.content) },
        ] }],
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

const { isOwner, requireOwner, serverKeyStatus } = require("./_auth");
const { contextFor, COACH_IDS } = require("./_context");

// The shared team context for a coach (api/_context.js). Appended to the live
// part of the system prompt, so chat and cron coaches work from the same facts.
async function teamContext(ctx) {
  if (!ctx || !COACH_IDS.includes(ctx.coach)) return null;
  try { return await contextFor({ coach: ctx.coach, purpose: ctx.purpose === "huddle" ? "huddle" : "chat" }); }
  catch (_) { return null; }
}

module.exports = async function handler(req, res) {
  // GET /api/ai is a setup check you can open in a browser: it reports which
  // provider keys this deployment can see (never the keys themselves) and
  // whether a one-word Claude call actually succeeds.
  if (req.method === "GET") {
    // ?context=<coach> (owner only): exactly what that coach gets from the server — no AI call.
    if (req.query && req.query.context) {
      if (!(await requireOwner(req, res))) return;
      const pk = await teamContext({ coach: String(req.query.context), purpose: req.query.purpose });
      if (!pk) return res.status(400).json({ error: "unknown coach" });
      return res.status(200).json(pk);
    }
    // ?check=db (owner only): can the crons reach his data? Cheap, no AI calls.
    if (req.query && req.query.check === "db") {
      if (!(await requireOwner(req, res))) return;
      return res.status(200).json({ serverKey: await serverKeyStatus() });
    }
    const status = {
      claudeKey: !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_KEY),
      groqKey: !!process.env.GROQ_API_KEY,
      geminiKey: !!process.env.GEMINI_API_KEY,
      proModel: PRO_MODEL,
      chatModel: SMART_MODEL,
      fastModel: FAST_MODEL,
    };
    // Live test calls cost money — only for the logged-in owner.
    if (status.claudeKey && await isOwner(req)) {
      try {
        await callClaude("Reply with one word.", [{ role: "user", content: "ping" }], 50);
        status.claude = "ok";
        try { await callClaude("Reply with one word.", [{ role: "user", content: "ping" }], 50, { model: SMART_MODEL }); status.chat = "ok"; }
        catch (e) { status.chat = redact(e.message); }
        try { await callClaude("Reply with one word.", [{ role: "user", content: "ping" }], 50, { model: PRO_MODEL }); status.pro = "ok"; }
        catch (e) { status.pro = redact(e.message); }
      } catch (e) {
        status.claude = redact(e.message);
      }
    }
    return res.status(200).json(status);
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireOwner(req, res))) return;

  const { max, provider, tier, effort, context } = req.body || {};
  let { system, messages } = req.body || {};
  if (!system || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "system and messages[] are required" });
  }
  // Coach chats ask for the shared team context; it goes after everything else
  // (the live, uncached part). If it can't be built the chat still works.
  const pk = await teamContext(context);
  if (pk) system = String(system) + "\n\n" + pk.text + "\n(This team context is the shared record every coach uses. If it disagrees with the app data above, the app may not have synced yet — go with what he tells you now, and don't accuse him over a gap.)";
  // Coaches can send several texts in a row (and text first), so the chat can
  // hold consecutive assistant messages — fold same-role runs into one turn.
  // Only the newest user message may carry photos: one in chat, up to 6 in
  // the weekly check-in (before/after pairs), about 1MB each and 4MB total.
  const lastIdx = messages.length - 1;
  const okImg = x => typeof x === "string" && x.length < 1500000 && parseImage(x);
  messages = messages.reduce((out, m, i) => {
    let images = null;
    if (i === lastIdx && m.role === "user") {
      images = (Array.isArray(m.images) ? m.images : m.image ? [m.image] : []).filter(okImg).slice(0, 6);
      let total = 0;
      images = images.filter(x => (total += x.length) < 4000000);
      if (!images.length) images = null;
    }
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = String(last.content) + "\n\n" + String(m.content);
      if (images) last.images = images;
    } else out.push(Object.assign({ role: m.role, content: String(m.content) }, images ? { images } : {}));
    return out;
  }, []);
  if (messages[0].role !== "user") messages.unshift({ role: "user", content: "(Jeet opened the chat)" });

  const order = provider && CALLERS[provider]
    ? [provider, ...PROVIDER_ORDER.filter(p => p !== provider)]
    : PROVIDER_ORDER;

  const errors = [];
  for (const p of order) {
    // Claude: start at the asked-for tier and step down on failure.
    const chain = tier === "pro" ? [PRO_MODEL, SMART_MODEL, FAST_MODEL] : tier === "smart" ? [SMART_MODEL, FAST_MODEL] : [FAST_MODEL];
    const attempts = p === "claude" ? [...new Set(chain)].map(model => ({ model, effort })) : [null];
    for (const opts of attempts) {
      try {
        const text = await CALLERS[p](system, messages, max, opts);
        return res.status(200).json(Object.assign({ text, provider: p, model: opts && opts.model }, context ? { context: pk ? "ok" : "unavailable" } : {}));
      } catch (e) {
        errors.push(redact(e.message));
        // A missing or bad key fails the same way on every model.
        if (/not configured|malformed|401/.test(e.message)) break;
      }
    }
  }
  // Report every provider's failure, not just the last one — the first
  // (Claude) error is usually the one that matters.
  return res.status(502).json({ error: errors.join(" | ") || "No AI provider configured" });
};
