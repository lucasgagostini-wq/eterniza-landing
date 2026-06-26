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

// Aspecto do poster de homenagem (referências são ~4:5 retrato).
const AR = process.env.PREVIEW_AR || '4:5';

// Template do prompt do POSTER de homenagem. {NOME} {REL} {FRASE} são preenchidos com os dados do funil.
// Sobrescrevível por env PREVIEW_PROMPT (mantenha os placeholders {NOME}/{REL}/{FRASE}).
const PROMPT_TPL = (process.env.PREVIEW_PROMPT || `Create a premium, deeply emotional Brazilian memorial tribute poster ("homenagem"), vertical 4:5 portrait.

THE PERSON (most important): Use the person from the provided photo. Preserve their face, features, hair and likeness with PERFECT fidelity — they must remain instantly recognizable as the same person. Show them from the chest up, calm and serene, looking gently toward the viewer, rendered in a warm soft golden sepia tone, beautifully lit.

SCENE: Behind the person, a luminous golden stairway ascends into heaven; at the top stands Jesus Christ in flowing white robes with open, welcoming arms, bathed in warm divine golden light among soft glowing clouds. Elegant white lilies and delicate golden flowers decorate the lower corners. An ornate golden filigree border frames the entire poster.

TEXT — render the following Brazilian Portuguese text, correctly spelled, in elegant luminous GOLD typography, well composed and NOT overlapping the person's face:
- a small gold serif line at the top: "Em memória de"
- the name in large elegant gold cursive calligraphy: "{NOME}"
- just below it, in refined gold serif: "{REL}"
- a heartfelt memorial sentence in elegant dark serif: "{FRASE}"
- at the very bottom, a small golden ribbon banner with a little white dove, reading: "Prévia da homenagem"

STYLE: sacred, warm, comforting, timeless and tasteful. Photorealistic face, painterly heavenly background, ornate and elegant. High quality.`).trim();

// ⚗️ VARIANTE A TESTAR NO FUTURO (revertida 25/06 p/ manter o prompt validado dos 3 posters):
// reforço de grafia exata do nome — corta erro tipo "Renán". Pra testar, adicionar este bloco
// no template acima, logo ANTES de "STYLE:" (ou setar via env PREVIEW_PROMPT):
//   SPELLING — CRITICAL: write the name and every word EXACTLY as given above, preserving the
//   exact letters and accents — do NOT add, remove or alter any accent or letter.
// (essa versão ficou no commit b793ee6, caso queira recuperar inteira.)

function buildFrase(memoria) {
  var m = (memoria || '').toString().trim();
  if (!m) return 'Sua memória vive para sempre em nossos corações.';
  if (/cora[çc][õo]|para sempre|saudade|etern/i.test(m)) return m;       // já é frase completa
  if (m.length <= 46) return m + ' continua vivo em nossos corações.';   // completa memória curta
  return m;
}
function buildPrompt(body) {
  var NOME = (body.nome || '').toString().trim() || 'quem partiu';
  var REL = (body.quem || body.relacao || '').toString().trim();
  var FRASE = (body.frase || '').toString().trim() || buildFrase(body.memoria);
  return PROMPT_TPL.replace(/\{NOME\}/g, NOME).replace(/\{REL\}/g, REL).replace(/\{FRASE\}/g, FRASE).trim();
}

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

async function callGemini(base64, mime, prompt) {
  const body = {
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: mime, data: base64 } },
      { text: prompt },
    ] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: AR } },
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

async function callOpenRouter(base64, mime, prompt) {
  const dataUrl = `data:${mime};base64,${base64}`;
  const body = {
    model: OR_MODEL,
    modalities: ['image', 'text'], // pede saída de IMAGEM (senão volta só texto)
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
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

// Libera a página homenagem.html (mesmo domínio) SEM expor o segredo: checa Origin/Referer.
const ALLOWED_HOSTS = ['eternizamemori.site', 'eterniza-memorias.vercel.app', 'localhost', '127.0.0.1'];
function reqOriginHost(req) {
  try { const o = req.headers.origin || req.headers.referer || ''; return o ? new URL(o).hostname.toLowerCase() : ''; }
  catch (e) { return ''; }
}
function originAllowed(h) { return !!h && ALLOWED_HOSTS.some(d => h === d || h.endsWith('.' + d)); }

module.exports = async (req, res) => {
  // CORS p/ a página chamar do nosso domínio (e localhost no teste)
  const allowOrigin = originAllowed(reqOriginHost(req));
  if (req.headers.origin && allowOrigin) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const q = req.query || {};
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // auth: segredo (bot/interno) OU origem permitida (página pública do nosso domínio)
  const sent = (q.token || body.token || '').toString().trim();
  if (!(TOKEN && sent === TOKEN) && !allowOrigin) return res.status(401).json({ error: 'unauthorized' });
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
    const prompt = buildPrompt(body);
    const gen = provider === 'openrouter' ? await callOpenRouter(src.base64, src.mime, prompt) : await callGemini(src.base64, src.mime, prompt);
    const noWm = q.nowm === '1' || q.nowm === 'true' || body.nowm === true || body.nowm === 1;
    const wm = noWm ? gen : await applyWatermark(gen.base64, gen.mime);
    const previewUrl = await uploadToStorage(wm.base64, wm.mime);
    console.log('[preview] ok (' + provider + ') ->', previewUrl);
    return res.status(200).json({ ok: true, previewUrl, provider });
  } catch (e) {
    const detail = String(e && e.message || e).slice(0, 320);
    console.log('[preview] ERRO:', detail);
    return res.status(500).json({ error: 'preview_failed', detail });
  }
};
