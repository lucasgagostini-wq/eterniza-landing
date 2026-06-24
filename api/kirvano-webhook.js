// Webhook do Kirvano. UPSERT em `orders` por phone_normalized (funde com o lead do
// Typebot: foto+respostas + pagamento). Migrado do Cakto em 2026-06-22 (Cakto pingava
// "golpe" no Pix). Protegido por token: ?token= ou body.token == KIRVANO_TOKEN|CAKTO_SECRET.
const { normalizePhone, pick, getByPath, upsertOrder } = require('./_lib');

// evento do Kirvano -> qual status aplicar (SALE_APPROVED, PIX_GENERATED, ABANDONED_CART...)
function detectKirvanoStatus(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const ev = String(pick(rec.event, rec.type, rec.event_name) || '').toLowerCase();
  const st = String(pick(rec.status, getByPath(rec, 'payment.status'), getByPath(rec, 'sale.status')) || '').toLowerCase();
  const pm = String(pick(rec.payment_method, rec.method) || '').toLowerCase();
  if (ev.includes('approved') || ev.includes('paid') || ['approved', 'paid', 'completed', 'confirmed', 'aprovado', 'pago'].includes(st)) return 'pago';
  if (ev.includes('pix') || (pm.includes('pix') && (ev.includes('generated') || st.includes('pending') || st.includes('waiting')))) return 'recuperacao_pix';
  if (ev.includes('abandoned') || ev.includes('cart')) return 'checkout_iniciado';
  return null; // recusada/reembolso/chargeback/boleto -> IGNORA (nunca vira 'pago' por engano)
}

// "R$ 49,90" / "49,90" / 49.9 -> 49.9
function parseValor(v) {
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[^\d,.-]/g, '').trim();
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return isNaN(n) ? undefined : n;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const TOKEN = (process.env.KIRVANO_TOKEN || process.env.CAKTO_SECRET || '').trim();

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const sent = (req.query.token || body.token || req.headers['security-token'] || req.headers['token'] || req.headers['x-kirvano-token'] || '').toString().trim();
  if (!TOKEN || sent !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'env_missing' });

  const data = body.data || body;
  const customer = data.customer || data.cliente || body.customer || data.buyer || {};

  const phoneRaw = pick(customer.phone_number, customer.phone, customer.cellphone, customer.telefone, customer.celular, customer.whatsapp, data.phone, body.phone);
  const phone_normalized = normalizePhone(phoneRaw);
  const emailRaw = pick(customer.email, data.customer_email, body.email);
  const email = emailRaw ? String(emailRaw).toLowerCase().trim() : null;
  const name = pick(customer.name, customer.nome, data.customer_name, body.name);
  const valor = parseValor(pick(data.total_price, data.amount, data.value, data.valor, data.total, body.total_price, body.amount));

  const detected = detectKirvanoStatus(data) || detectKirvanoStatus(body);
  console.log('[kirvano-webhook]', JSON.stringify({ event: pick(body.event, data.event), detected, phone: phone_normalized, name, valor }));
  if (!detected) return res.status(200).json({ ok: true, ignored: 'evento_nao_mapeado' });
  // pagamento confirmado já entra na FILA DE EDIÇÃO (hub: aba Produzir; cliente: "Na fila de edição")
  const status = (detected === 'pago') ? 'fila_edicao' : detected;

  const patch = {
    customer_name: name || undefined,
    customer_email: email || undefined,
    customer_phone: phoneRaw ? String(phoneRaw) : undefined,
    phone_normalized: phone_normalized || undefined,
    valor: valor != null ? valor : undefined,
    payment_status: String(pick(data.status, body.status, 'paid')),
    status,
    cakto_payload: { _gateway: 'kirvano', ...body }, // coluna jsonb genérica do gateway
  };
  if (status === 'recuperacao_pix') patch.pix_generated_at = new Date().toISOString();
  Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);

  try {
    const r = await upsertOrder({ phone_normalized, email, fields: patch, newStatus: status });
    if (r.existed) {
      // não rebaixa: pedido já igual/à frente no pipeline preserva o status atual
      const RANK = { erro: 0, briefing_recebido: 1, checkout_iniciado: 2, recuperacao_pix: 2, pago: 3, fila_edicao: 4, produzindo: 5, pronta: 6, entregue: 7 };
      if ((RANK[r.status] ?? 0) >= (RANK[status] ?? 0)) { delete patch.status; delete patch.pix_generated_at; }
      await r.update(patch);
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'upsert_failed', detail: String(e.message || e).slice(0, 300) });
  }
};
