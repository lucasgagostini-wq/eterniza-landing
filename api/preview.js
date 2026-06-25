// Gera a PRÉVIA da homenagem: foto do ente querido -> imagem "ao lado de Cristo" (Google Gemini),
// hospeda no Supabase Storage e devolve a URL pública. Chamado pelo bot logo após a foto.
// Auth por ?token= (= PREVIEW_TOKEN | CAKTO_SECRET) p/ não deixar qualquer um gastar a API.
const { SB, KEY } = require('./_lib');
let sharp = null; try { sharp = require('sharp'); } catch (e) { /* sem sharp: sobe imagem limpa */ }

// Provedor de imagem: usa OpenRouter se a chave existir (pré-pago avulso, sem mínimo de R$200 do Google),
// senão cai pro Gemini direto. Ambos chamam o MESMO modelo (nano-banana / gemini-2.5-flash-image).
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const OR_MODEL = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image';
const BUCKET = 'previas';
const TOKEN = (process.env.PREVIEW_TOKEN || process.env.CAKTO_SECRET || '').trim();

// Prompt da prévia (reverse-engineered da saída do RevivaPic: reencontro na escadaria do céu).
// Pode ser sobrescrito sem mexer no código via env PREVIEW_PROMPT (pra tunar fino na Vercel).
const PROMPT = (process.env.PREVIEW_PROMPT || `Using the person in the provided photo, create a deeply emotional, photorealistic memorial tribute image in a vertical 9:16 portrait orientation.

THE PERSON (most important): Recreate this exact person as a FULL-BODY figure standing calmly and facing forward, with a serene peaceful smile and one hand gently raised in a soft wave of greeting. Preserve their FACE, facial features, skin tone, hair, age and overall likeness with perfect fidelity — they must remain instantly recognizable as the very same person from the photo. If the photo only shows the head and shoulders, naturally and seamlessly extend them to a realistic full body. Dress them in clean, dignified, respectful clothing consistent with how they appear in the photo (keep any clearly visible attire such as a clergy collar, uniform or characteristic style).

THE SCENE: Place the person in the lower-center foreground, at the foot of a grand white marble staircase with elegant golden railings that ascends gently into soft white clouds toward heaven. At the very top of the staircase stands Jesus Christ in a flowing white robe, arms open in a warm loving welcome, bathed in radiant golden light beaming down from above. Soft billowing clouds frame both sides, calm blue sky, warm divine golden light over everything.

STYLE: Photorealistic and cinematic, serene, sacred and celestial — a comforting heavenly reunion. Dignified and deeply emotional. Sharp, faithful focus on the person's face. Absolutely NO text, NO watermark, NO logo and NO caption anywhere in the image.`).trim();

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
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' } },
  };
  // Chave vai no header x-goog-api-key (as keys novas "AQ." NÃO funcionam mais com ?key= na URL).
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify(body),
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

async function callOpenRouter(base64, mime) {
  const dataUrl = `data:${mime};base64,${base64}`;
  const body = {
    model: OR_MODEL,
    modalities: ['image', 'text'], // pede saída de IMAGEM (senão volta só texto)
    messages: [{ role: 'user', content: [
      { type: 'text', text: PROMPT },
      { type: 'image_url', image_url: { url: dataUrl } },
    ] }],
  };
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://eternizamemori.site',
      'X-Title': 'Eterniza Previa',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('openrouter_http_' + r.status + ':' + JSON.stringify(j).slice(0, 280));
  const msg = j?.choices?.[0]?.message || {};
  const imgs = msg.images || [];
  const url = imgs[0]?.image_url?.url || imgs[0]?.url || '';
  if (!url || !url.startsWith('data:')) {
    const reason = j?.choices?.[0]?.finish_reason || j?.error?.message || 'sem_imagem';
    throw new Error('openrouter_sem_imagem_' + reason + ':' + JSON.stringify(j).slice(0, 220));
  }
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('openrouter_dataurl_invalida');
  return { base64: m[2], mime: m[1] || 'image/png' };
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

// Carimba "PRÉVIA ETERNIZA" DENTRO da imagem (igual o RevivaPic) compondo um PNG pré-renderizado
// (gerado no PC com fonte garantida) — assim NÃO depende de fonte no servidor da Vercel.
// Sem sharp / sem marca / erro? devolve a imagem limpa (a prévia nunca quebra por causa do carimbo).
const WM_PNG = (() => { try { return Buffer.from(require('./_watermark'), 'base64'); } catch (e) { return null; } })();
async function applyWatermark(base64, mime) {
  if (!sharp || !WM_PNG) return { base64, mime };
  try {
    const input = Buffer.from(base64, 'base64');
    const meta = await sharp(input).metadata();
    const W = meta.width || 768, H = meta.height || 1365;
    const wm = await sharp(WM_PNG).resize(W, H, { fit: 'fill' }).toBuffer();
    const out = await sharp(input).composite([{ input: wm }]).png().toBuffer();
    return { base64: out.toString('base64'), mime: 'image/png' };
  } catch (e) {
    console.log('[preview] watermark falhou, subindo imagem limpa:', String(e && e.message || e).slice(0, 120));
    return { base64, mime };
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const q = req.query || {};
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const sent = (q.token || body.token || '').toString().trim();
  if (!TOKEN || sent !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  if (!OPENROUTER_KEY && !GEMINI_KEY) return res.status(500).json({ error: 'image_provider_key_missing' });
  if (!SB || !KEY) return res.status(500).json({ error: 'supabase_env_missing' });

  // provedor: ?provider=openrouter|gemini força; default = openrouter se tiver a chave, senão gemini
  const provider = (q.provider || body.provider || (OPENROUTER_KEY ? 'openrouter' : 'gemini')).toString().trim();
  if (provider === 'openrouter' && !OPENROUTER_KEY) return res.status(500).json({ error: 'openrouter_key_missing' });
  if (provider === 'gemini' && !GEMINI_KEY) return res.status(500).json({ error: 'gemini_key_missing' });

  const photoUrl = (q.foto || q.photoUrl || q.url || body.foto || body.photoUrl || body.url || '').toString().trim();
  const fotoB64 = (body.fotoB64 || body.imageB64 || '').toString().trim();
  if (!photoUrl && !fotoB64) return res.status(400).json({ error: 'foto_missing' });

  try {
    // foto pode vir como URL (fetch) OU base64 direto no body (data: URL ou base64 cru)
    let src;
    if (fotoB64) {
      const m = fotoB64.match(/^data:([^;]+);base64,(.+)$/);
      src = m ? { base64: m[2], mime: m[1] } : { base64: fotoB64, mime: 'image/jpeg' };
    } else {
      src = await fetchAsBase64(photoUrl);
    }
    const gen = provider === 'openrouter' ? await callOpenRouter(src.base64, src.mime) : await callGemini(src.base64, src.mime);
    const wm = await applyWatermark(gen.base64, gen.mime);
    const previewUrl = await uploadToStorage(wm.base64, wm.mime);
    console.log('[preview] ok (' + provider + ') ->', previewUrl);
    return res.status(200).json({ ok: true, previewUrl, provider });
  } catch (e) {
    const detail = String(e && e.message || e).slice(0, 320);
    console.log('[preview] ERRO:', detail);
    return res.status(500).json({ error: 'preview_failed', detail });
  }
};
