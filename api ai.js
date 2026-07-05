// Vercel serverless function - api/ai.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({error: 'Method not allowed'});

  const { type, messages, system, prompt } = req.body;

  try {
    if (type === 'groq') {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer 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'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 800,
          temperature: 0.85,
          messages: [{role: 'system', content: system}, ...messages]
        })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || r.status);
      return res.json({text: d?.choices?.[0]?.message?.content || ''});
    }

    if (type === 'gemini') {
      const key = 'AQ.Ab8RN6IGFo8mtyN7ufiDqS7TUrUERq-8lUX0xqluGkP7AM9GJg';
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          contents: [{role: 'user', parts: [{text: prompt}]}],
          generationConfig: {maxOutputTokens: 500, temperature: 0.8}
        })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || r.status);
      return res.json({text: d?.candidates?.[0]?.content?.parts?.[0]?.text || ''});
    }

    return res.status(400).json({error: 'Invalid type'});
  } catch(e) {
    return res.status(500).json({error: e.message});
  }
}
