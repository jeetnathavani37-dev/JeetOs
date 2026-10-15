// api/_claude.js — one small Claude call for server jobs (huddle etc.).
// The chat model first, then the fast one; tags are stripped from the reply.
const MODELS = () => [...new Set([(process.env.CLAUDE_CHAT_MODEL || "claude-sonnet-5-5").trim(), (process.env.CLAUDE_FAST_MODEL || "claude-haiku-5-5").trim()])];
async function callClaude(system, user, max) {
  const key = (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_KEY || "").trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");
  let last;
  for (const model of MODELS()) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, output_config: { effort: "low" }, max_tokens: max || 3000, system, messages: [{ role: "user", content: user }] }),
    });
    const d = await r.json().catch(() => ({}));
    const block = r.ok && d.stop_reason !== "refusal" && Array.isArray(d.content) && d.content.find(b => b.type === "text" && b.text);
    if (block) return block.text;
    last = new Error("Claude " + r.status + " (" + model + ")");
    if (r.status === 401) break;
  }
  throw last;
}
module.exports = { callClaude };
