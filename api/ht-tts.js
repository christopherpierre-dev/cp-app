export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const text = req.query.text;
  if (!text) { res.status(400).json({ error: 'text required' }); return; }

  const VOICE_ID = 'pNInz6obpgDQGcFmaJgB';
  const API_KEY = process.env.ELEVENLABS_API_KEY;
  if (!API_KEY) { res.status(500).json({ error: 'API key not configured' }); return; }

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });
    if (!r.ok) { res.status(r.status).json({ error: 'ElevenLabs error' }); return; }
    const buf = await r.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}