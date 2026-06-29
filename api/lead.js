// Ponte Typebot -> Supabase. Recebe foto + respostas + WhatsApp ANTES do pagamento
// e cria/atualiza o lead em `orders` (status briefing_recebido). Chamado pelo bloco
// HTTP do Typebot via QUERY PARAMS (encoda acentos/aspas com segurança) ou body JSON.
// IMPORTANTE: no bot, `nome` = o HOMENAGEADO (falecido) -> recipient_name.
const { normalizePhone, pick, clientIp, clientGeo, upsertOrder } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'env_missing' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const src = { ...(req.query || {}), ...(body || {}) }; // body sobrescreve query

  const phoneRaw = pick(src.whatsapp, src.phone, src.telefone, src.celular);
  const phone_normalized = normalizePhone(phoneRaw);
  const email = src.email ? String(src.email).toLowerCase().trim() : null;
  if (!phone_normalized && !email) return res.status(400).json({ error: 'sem_contato' });

  const fields = {
    // comprador (o bot não captura; vem do Cakto). recipient = homenageado (bot `nome`)
    customer_name: pick(src.comprador, src.customer_name, src.buyer_name),
    customer_email: email || undefined,
    customer_phone: phoneRaw ? String(phoneRaw) : undefined,
    phone_normalized: phone_normalized || undefined,
    recipient_name: pick(src.homenageado, src.recipient_name, src.nome, src.nome_falecido, src.ente),
    relationship: pick(src.parente, src.relationship, src.relacao, src.grau),
    memory: pick(src.memoria, src.memory, src.lembranca, src.historia),
    photo_url: pick(src.foto, src.photo_url, src.foto_url, src.imagem),
    // payload do lead + IP/região (capturados no servidor; exibidos no hub perto do nome)
    typebot_payload: { ...src, _ip: clientIp(req) || undefined, _geo: clientGeo(req) || undefined, _ip_at: new Date().toISOString() },
  };
  Object.keys(fields).forEach(k => (fields[k] === undefined || fields[k] === null) && delete fields[k]);

  try {
    const r = await upsertOrder({ phone_normalized, email, fields, newStatus: 'briefing_recebido' });
    if (r.existed) await r.update(fields); // não rebaixa status; só atualiza dados do briefing
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'lead_failed', detail: String(e.message || e).slice(0, 300) });
  }
};
