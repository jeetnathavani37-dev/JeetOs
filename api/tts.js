// api/tts.js
// Each coach's own voice. POST { coach, text } → audio. Uses the first TTS
// key configured in Vercel env vars:
//   ELEVENLABS_API_KEY  — most natural, great with Hinglish
//   OPENAI_API_KEY      — gpt-4o-mini-tts with a per-coach speaking style
//   GEMINI_API_KEY      — Gemini TTS
// With none set it answers 501 and the app falls back to the phone's
// built-in voices, so voice still works without any key.

const { COACHES } = require("./_coach-personas");

// Per-coach voice casting for each provider (genders match the personas).
const VOICES = {
  skin:      { eleven: "21m00Tcm4TlvDq8ikWAM", openai: "shimmer", gemini: "Kore",      style: "calm, precise, slightly dry humour; a composed woman doctor" },
  hair:      { eleven: "ErXwobaYiN019PkySvjV", openai: "echo",    gemini: "Umbriel",   style: "laid-back, chilled-out young guy, relaxed pace" },
  fitness:   { eleven: "VR6AewLTigWG4xSOukaG", openai: "onyx",    gemini: "Fenrir",    style: "loud, hyped gym coach, energetic and punchy" },
  nutrition: { eleven: "EXAVITQu4vr4xnSDxMaL", openai: "coral",   gemini: "Sulafat",   style: "warm, friendly woman who loves food, smiling as she talks" },
  sleep:     { eleven: "yoZ06aMxZJJ28mfd3POQ", openai: "sage",    gemini: "Iapetus",   style: "soft-spoken, slow, soothing, a little nerdy" },
  style:     { eleven: "TxGEqnHWrfWFTfGW9XjX", openai: "ash",     gemini: "Puck",      style: "sassy, dramatic, expressive fashion guy" },
  grooming:  { eleven: "pNInz6obpgDQGcFmaJgB", openai: "ballad",  gemini: "Algenib",   style: "few words, low, blunt barber" },
  ronaldo:   { eleven: "VR6AewLTigWG4xSOukaG", openai: "onyx",    gemini: "Alnilam",   style: "intense, proud, competitive athlete; short punchy delivery" },
  mind:      { eleven: "MF3mGyEYCl7XYWbV9V3O", openai: "nova",    gemini: "Aoede",     style: "warm, gentle, patient woman therapist; calm and unhurried" },
};
const ACCENT = "Speak with a natural Indian accent. The text is Hinglish (Hindi written in English letters mixed with English) — pronounce the Hindi words the Indian way.";

async function eleven(key, v, text) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v.eleven}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35 } }),
  });
  if (!r.ok) throw new Error("ElevenLabs " + r.status);
  return { type: "audio/mpeg", buf: Buffer.from(await r.arrayBuffer()) };
}

async function openai(key, v, text) {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: v.openai, input: text, instructions: `${ACCENT} Voice and tone: ${v.style}.`, response_format: "mp3" }),
  });
  if (!r.ok) throw new Error("OpenAI TTS " + r.status);
  return { type: "audio/mpeg", buf: Buffer.from(await r.arrayBuffer()) };
}

// Gemini returns raw 16-bit PCM; wrap it in a WAV header so browsers can play it.
function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
async function gemini(key, v, text) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=" + key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${ACCENT} Say it in this style — ${v.style}:\n${text}` }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: v.gemini } } } },
    }),
  });
  const d = await r.json().catch(() => ({}));
  const part = d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts.find(p => p.inlineData);
  if (!r.ok || !part) throw new Error("Gemini TTS " + r.status);
  const rate = +((/rate=(\d+)/.exec(part.inlineData.mimeType || "") || [])[1] || 24000);
  return { type: "audio/wav", buf: pcmToWav(Buffer.from(part.inlineData.data, "base64"), rate) };
}

const PROVIDERS = [
  ["ELEVENLABS_API_KEY", eleven],
  ["OPENAI_API_KEY", openai],
  ["GEMINI_API_KEY", gemini],
];

module.exports = async function handler(req, res) {
  const available = PROVIDERS.filter(([env]) => (process.env[env] || "").trim());
  if (req.method === "GET") return res.status(200).json({ providers: available.map(([env]) => env) });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { coach, text } = req.body || {};
  const v = VOICES[coach];
  const clean = String(text || "").replace(/<[^>]+>/g, "").trim().slice(0, 1200);
  if (!v || !COACHES[coach] || !clean) return res.status(400).json({ error: "coach and text are required" });
  if (!available.length) return res.status(501).json({ error: "No TTS key configured" });

  const errors = [];
  for (const [env, fn] of available) {
    try {
      const out = await fn(process.env[env].trim(), v, clean);
      res.setHeader("Content-Type", out.type);
      res.setHeader("Cache-Control", "private, max-age=86400");
      return res.status(200).send(out.buf);
    } catch (e) {
      errors.push(e.message);
    }
  }
  return res.status(502).json({ error: errors.join(" | ") });
};
