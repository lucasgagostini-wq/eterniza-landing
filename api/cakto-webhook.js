// Webhook do Cakto. Faz UPSERT em `orders` por phone_normalized (casa com o lead
// do Typebot, fundindo foto+respostas com o pagamento). Protegido por ?secret=.
const { normalizePhone, pick, firstOf, detectCaktoStatus, upsertOrder } = require('./_lib');

module.exports = async (req, res) => {
  // DESATIVADO (07/2026): checkout é 100% Yampi. Endpoint sem uso + secret fraco = superfície de
  // ataque (venda/pixel falso). Retorna 410 até reativar com CAKTO_ENABLED=1 e um secret FORTE.
  if ((process.env.CAKTO_ENABLED || '') !== '1') return res.status(410).json({ error: 'gone' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const SECRET = (process.env.CAKTO_SECRET || '').trim();
  if (!SECRET || (req.query.secret || '').toString().trim() !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'env_missing' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const data = body.data || body;
  const customer = data.customer || data.cliente || body.customer || data.buyer || {};

  const phoneRaw = pick(customer.phone, customer.cellphone, customer.phone_number, customer.telefone, customer.celular, customer.whatsapp, data.phone, body.phone, firstOf(body, ['customer.phone', 'buyer.phone', 'data.customer.phone']));
  const phone_normalized = normalizePhone(phoneRaw);
  const emailRaw = pick(customer.email, data.customer_email, body.email, firstOf(body, ['customer.email', 'data.customer.email']));
  const email = emailRaw ? String(emailRaw).toLowerCase().trim() : null;
  const name = pick(customer.name, customer.nome, data.customer_name, body.name, firstOf(body, ['customer.name', 'buyer.name']));
  const valorRaw = pick(data.amount, data.value, data.valor, data.total, body.amount);
  // status seguro: 'paid'->pago, pix/waiting->recuperacao_pix, checkout->checkout_iniciado.
  // Evento não reconhecido (recusa/reembolso/chargeback) é IGNORADO — nunca vira 'pago' por engano.
  const detected = detectCaktoStatus(data) || detectCaktoStatus(body);
  if (!detected) return res.status(200).json({ ok: true, ignored: 'evento_nao_mapeado' });
  // pagamento confirmado já entra na FILA DE EDIÇÃO (hub: aba Produzir; cliente: "Na fila de edição")
  const status = (detected === 'pago') ? 'fila_edicao' : detected;

  const patch = {
    customer_name: name || undefined,
    customer_email: email || undefined,
    customer_phone: phoneRaw ? String(phoneRaw) : undefined,
    phone_normalized: phone_normalized || undefined,
    valor: valorRaw != null ? Number(valorRaw) : undefined,
    payment_status: String(pick(data.status, body.status, 'paid')),
    status,
    cakto_payload: { _gateway: 'cakto', ...body }, // etiqueta p/ atribuição do A/B (Yampi grava 'yampi')
  };
  if (status === 'recuperacao_pix') patch.pix_generated_at = new Date().toISOString();
  Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);

  try {
    const r = await upsertOrder({ phone_normalized, email, fields: patch, newStatus: status });
    if (r.existed) {
      // não rebaixa: se o pedido já está igual/à frente no pipeline, preserva o status atual
      // (ex: pix tardio em pedido já na fila/produção; webhook duplicado em pedido já entregue)
      const RANK = { erro: 0, briefing_recebido: 1, checkout_iniciado: 2, recuperacao_pix: 2, pago: 3, fila_edicao: 4, produzindo: 5, pronta: 6, entregue: 7 };
      if ((RANK[r.status] ?? 0) >= (RANK[status] ?? 0)) { delete patch.status; delete patch.pix_generated_at; }
      await r.update(patch);
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'upsert_failed', detail: String(e.message || e).slice(0, 300) });
  }
};
