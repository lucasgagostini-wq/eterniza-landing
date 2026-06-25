// Webhook do Yampi. UPSERT em `orders` por phone_normalized (funde o pagamento com o
// lead do Typebot: foto+respostas). Migrado do Cakto em 2026-06-24.
// FUSÃO: prioriza o telefone do bot vindo em metadata.bot_phone (injetado pela ponte
// ir-checkout.html). Assim casa com o lead mesmo que o cliente digite outro número no checkout.
// Auth por ?token= (= YAMPI_TOKEN | CAKTO_SECRET) na URL cadastrada na Yampi.
const { normalizePhone, pick, getByPath, upsertOrder, sendMetaPurchase } = require('./_lib');

// evento/status do Yampi -> status interno. order.paid = pago; order.created/waiting = pix gerado.
function detectYampiStatus(ev, st) {
  ev = String(ev || '').toLowerCase();
  st = String(st || '').toLowerCase();
  if (ev.includes('paid') || ['paid', 'approved', 'completed', 'authorized', 'aprovado'].includes(st)) return 'pago';
  if (ev.includes('created') || ['waiting_payment', 'pending', 'waiting', 'billet_printed'].includes(st)) return 'recuperacao_pix';
  return null; // cancelado/reembolso/chargeback -> IGNORA (nunca vira pago por engano)
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
  const TOKEN = (process.env.YAMPI_TOKEN || process.env.CAKTO_SECRET || '').trim();

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const sent = (req.query.token || body.token || req.headers['x-yampi-token'] || '').toString().trim();
  if (!TOKEN || sent !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'env_missing' });

  // Yampi aninha o pedido em resource/data; e o customer pode vir em customer.data. Defensivo.
  const r = body.resource || body.data || body;
  const cust = (r.customer && (r.customer.data || r.customer)) || {};
  const meta = r.metadata || body.metadata || getByPath(r, 'metadata.data') || {};

  // telefone p/ FUSÃO: 1º o metadata do bot, depois o que o cliente digitou no checkout.
  const botPhone = pick(meta.bot_phone, getByPath(body, 'metadata.bot_phone'), getByPath(r, 'metadata.bot_phone'));
  const custPhone = pick(getByPath(cust, 'phone.full_number'), getByPath(cust, 'phone.number'), cust.phone, cust.cellphone, cust.whatsapp);
  const phoneRaw = botPhone || custPhone;
  const phone_normalized = normalizePhone(phoneRaw);

  const emailRaw = pick(cust.email, getByPath(r, 'customer.email'), r.email);
  const email = emailRaw ? String(emailRaw).toLowerCase().trim() : null;
  const name = pick(cust.name, getByPath(r, 'customer.name'), meta.bot_name, r.customer_name);
  const valor = parseValor(pick(r.value_total, r.value_products, r.value, r.total, r.amount));

  const ev = pick(body.event, body.type, r.event);
  const st = pick(getByPath(r, 'status.alias'), getByPath(r, 'status.data.alias'), getByPath(r, 'status.name'), r.status);
  const detected = detectYampiStatus(ev, st);
  console.log('[yampi-webhook]', JSON.stringify({ event: ev, status: st, detected, botPhone, custPhone, phone: phone_normalized, name, valor }));
  if (!detected) return res.status(200).json({ ok: true, ignored: 'evento_nao_mapeado' });

  // pagamento confirmado já entra na FILA DE EDIÇÃO (hub: aba Produzir; cliente: "Na fila de edição")
  const status = (detected === 'pago') ? 'fila_edicao' : detected;

  const patch = {
    customer_name: name || undefined,
    customer_email: email || undefined,
    customer_phone: phoneRaw ? String(phoneRaw) : undefined,
    phone_normalized: phone_normalized || undefined,
    valor: valor != null ? valor : undefined,
    payment_status: String(pick(st, ev, 'paid')),
    status,
    cakto_payload: { _gateway: 'yampi', ...body }, // coluna jsonb genérica do gateway
  };
  if (status === 'recuperacao_pix') patch.pix_generated_at = new Date().toISOString();
  Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);

  try {
    const o = await upsertOrder({ phone_normalized, email, fields: patch, newStatus: status });
    if (o.existed) {
      // não rebaixa: pedido já igual/à frente no pipeline preserva o status atual
      const RANK = { erro: 0, briefing_recebido: 1, checkout_iniciado: 2, recuperacao_pix: 2, pago: 3, fila_edicao: 4, produzindo: 5, pronta: 6, entregue: 7 };
      if ((RANK[o.status] ?? 0) >= (RANK[status] ?? 0)) { delete patch.status; delete patch.pix_generated_at; }
      await o.update(patch);
    }
    // CAPI: venda PAGA -> Purchase server-side pro Meta (atribuição cross-domain via fbp/fbc do metadata)
    let capiResult;
    if (detected === 'pago') {
      const orderId = pick(r.id, body.id, getByPath(r, 'data.id'), getByPath(body, 'resource.id'));
      capiResult = await sendMetaPurchase({
        value: valor, email, phone: phoneRaw,
        fbp: pick(meta.fbp, getByPath(r, 'metadata.fbp')),
        fbc: pick(meta.fbc, getByPath(r, 'metadata.fbc')),
        eventId: 'yampi_' + (orderId || (phone_normalized || '') + '_' + (valor || '')),
        eventSourceUrl: 'https://eternizamemori.site/',
      });
      console.log('[yampi-webhook] capi', JSON.stringify(capiResult));
    }
    return res.status(200).json({ ok: true, capi: req.query.debug ? (capiResult || null) : undefined });
  } catch (e) {
    return res.status(500).json({ error: 'upsert_failed', detail: String(e.message || e).slice(0, 300) });
  }
};
