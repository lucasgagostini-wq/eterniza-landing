// Gera a PRÉVIA da homenagem: foto do ente querido -> imagem "ao lado de Cristo" (Google Gemini),
// hospeda no Supabase Storage e devolve a URL pública. Chamado pelo bot logo após a foto.
// Auth por ?token= (= PREVIEW_TOKEN | CAKTO_SECRET) p/ não deixar qualquer um gastar a API.
const { SB, KEY } = require('./_lib');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const BUCKET = 'previas';
const TOKEN = (process.env.PREVIEW_TOKEN || process.env.CAKTO_SECRET || '').trim();

const PROMPT = `Crie uma homenagem visual respeitosa a partir desta foto. Coloque a pessoa retratada ao lado de Jesus Cristo, em uma cena serena e celestial, com luz dourada suave e acolhedora.
IMPORTANTE: preserve fielmente o ROSTO, os traços, a aparência e a idade da pessoa original — ela deve continuar perfeitamente reconhecível. Expressão de paz.
Estilo realista, digno e emocionante, como uma lembrança eterna de um ente querido. Sem texto, sem marca d'água.`;

const SBH = (extra) => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, ...(extra || {}) });

async function fetchAsBase64(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('download_foto_' + r.status);
  let mime = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (!mime.startsWith('image/')) mime = 'image/jpeg';
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('foto_vazia');
  return { base64: buf.toString('base64'), mime };
}

async function callGemini(base64, mime) {
  const body = {
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: mime, data: base64 } },
      { text: PROMPT },
    ] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('gemini_http_' + r.status + ':' + JSON.stringify(j).slice(0, 280));
  const parts = j?.candidates?.[0]?.content?.parts || [];
  const img = parts.find(p => (p.inlineData && p.inlineData.data) || (p.inline_data && p.inline_data.data));
  if (!img) {
    const reason = j?.candidates?.[0]?.finishReason || j?.promptFeedback?.blockReason || 'sem_imagem';
    throw new Error('gemini_sem_imagem_' + reason + ':' + JSON.stringify(j).slice(0, 220));
  }
  const inl = img.inlineData || img.inline_data;
  return { base64: inl.data, mime: inl.mimeType || inl.mime_type || 'image/png' };
}

async function ensureBucket() {
  await fetch(`${SB}/storage/v1/bucket`, {
    method: 'POST', headers: SBH({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  }).catch(() => {});
}

async function uploadToStorage(base64, mime) {
  const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('+xml', '');
  const path = `previa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const bytes = Buffer.from(base64, 'base64');
  const put = () => fetch(`${SB}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST', headers: SBH({ 'Content-Type': mime, 'x-upsert': 'true' }), body: bytes,
  });
  let up = await put();
  if (up.status === 404 || up.status === 400) { await ensureBucket(); up = await put(); }
  if (!up.ok) throw new Error('storage_' + up.status + ':' + (await up.text()).slice(0, 180));
  return `${SB}/storage/v1/object/public/${BUCKET}/${path}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const q = req.query || {};
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const sent = (q.token || body.token || '').toString().trim();
  if (!TOKEN || sent !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  if (!GEMINI_KEY) return res.status(500).json({ error: 'gemini_key_missing' });
  if (!SB || !KEY) return res.status(500).json({ error: 'supabase_env_missing' });

  const photoUrl = (q.foto || q.photoUrl || q.url || body.foto || body.photoUrl || body.url || '').toString().trim();
  if (!photoUrl) return res.status(400).json({ error: 'foto_missing' });

  try {
    const src = await fetchAsBase64(photoUrl);
    const gen = await callGemini(src.base64, src.mime);
    const previewUrl = await uploadToStorage(gen.base64, gen.mime);
    console.log('[preview] ok ->', previewUrl);
    return res.status(200).json({ ok: true, previewUrl });
  } catch (e) {
    const detail = String(e && e.message || e).slice(0, 320);
    console.log('[preview] ERRO:', detail);
    return res.status(500).json({ error: 'preview_failed', detail });
  }
};
