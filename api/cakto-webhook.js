// Webhook do Cakto. UPSERT em `orders` por phone_normalized (funde o pagamento com o lead
// do Typebot: foto+respostas). A /homenagem (oferta R$37) manda as vendas pra cá via pref=cakto.
//
// PARIDADE COM O YAMPI (02/07): antes esse endpoint só gravava no Hub — no 'pago' agora também
// dispara CAPI (Purchase server-side p/ o pixel 1560) + Discord (venda aprovada) + WhatsApp de
// confirmação; no pix gerado, Discord (recuperação). Sem isso as vendas da Cakto sumiam do Hub.
//
// Auth: ?secret= (token DEDICADO `CAKTO_WEBHOOK_TOKEN` — NÃO compartilha com hub/preview/yampi,
// pois esse valor vive no painel de um terceiro, a Cakto). Antes havia um gate CAKTO_ENABLED=1
// (410 quando desligado) — removido: a proteção é o secret FORTE, e um env a menos = menos ponto
// de falha silenciosa (foi o que derrubou o webhook do Yampi em 01/07).
const { normalizePhone, pick, firstOf, phoneCandidates, detectCaktoStatus, upsertOrder, sendMetaPurchase, sbSelect, sbUpdate } = require('./_lib');
const discord = require('./_discord');
const wa = require('./_whatsapp');

// ranking do pipeline (não rebaixar status; e detectar a 1ª transição p/ pago/pix -> notif 1x)
const RANK = { erro: 0, briefing_recebido: 1, checkout_iniciado: 2, recuperacao_pix: 2, pago: 3, fila_edicao: 4, produzindo: 5, pronta: 6, entregue: 7 };

// Anti-spam (mesmo espírito do yampi-webhook): no máx 1 alerta a cada 5 min por tipo.
let lastAuthAlert = 0;
async function alertAuthFailOnce(reason) {
  const now = Date.now();
  if (now - lastAuthAlert < 5 * 60 * 1000) return;
  lastAuthAlert = now;
  try { await discord.notifyWebhookFalhou({ gateway: 'Cakto', motivo: reason }); } catch (e) {}
}
let lastCapiAlert = 0;
function alertCapiFailOnce(capi) {
  const now = Date.now();
  if (now - lastCapiAlert < 5 * 60 * 1000) return;
  lastCapiAlert = now;
  const motivo = !capi ? 'sem resposta do CAPI'
    : capi.skipped ? ('skipped: ' + capi.skipped + ' (META_CAPI_TOKEN vazio?)')
    : capi.error ? ('erro: ' + capi.error)
    : ('HTTP ' + (capi.status || '?') + ': ' + String(capi.body || '').slice(0, 180));
  discord.notifyCapiFalhou({ gateway: 'Cakto', motivo }).catch(() => {});
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const SECRET = (process.env.CAKTO_WEBHOOK_TOKEN || '').trim();
  const sent = (req.query.secret || req.query.token || (req.body && req.body.token) || '').toString().trim();
  if (!SECRET || sent !== SECRET) {
    alertAuthFailOnce(!SECRET ? 'CAKTO_WEBHOOK_TOKEN nao configurado na Vercel' : 'secret recebido nao bate com o configurado (rotacionado sem atualizar no painel da Cakto?)').catch(() => {});
    return res.status(401).json({ error: 'unauthorized' });
  }
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
  const valor = valorRaw != null && !isNaN(Number(valorRaw)) ? Number(valorRaw) : undefined;
  // fbp/fbc só se a Cakto repassar no payload (ela costuma passar fbclid na URL); o CAPI
  // ainda casa a venda por email+telefone (hash) mesmo sem eles — atribuição só fica mais fraca.
  const fbp = pick(customer.fbp, data.fbp, body.fbp);
  const fbc = pick(customer.fbc, data.fbc, body.fbc);

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
    valor: valor != null ? valor : undefined,
    payment_status: String(pick(data.status, body.status, 'paid')),
    status,
    cakto_payload: { _gateway: 'cakto', ...body }, // etiqueta p/ atribuição do A/B (Yampi grava 'yampi')
  };
  if (status === 'recuperacao_pix') patch.pix_generated_at = new Date().toISOString();
  Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);

  const orderId = pick(data.id, body.id, data.order_id, firstOf(body, ['data.id', 'order.id', 'transaction.id']));
  console.log('[cakto-webhook]', JSON.stringify({ detected, phone: phone_normalized, email, name, valor, orderId }));

  try {
    const o = await upsertOrder({ phone_normalized, email, fields: patch, newStatus: status });
    // rank ANTES do update — é ele que diz se é a 1ª vez que o pedido chega em pago/pix (notif 1x)
    const prevRank = o.existed ? (RANK[o.status] ?? 0) : -1;
    if (o.existed) {
      // não rebaixa: pedido já igual/à frente no pipeline preserva o status atual
      if (prevRank >= (RANK[status] ?? 0)) { delete patch.status; delete patch.pix_generated_at; }
      await o.update(patch);
    }

    let capiResult;
    if (detected === 'pago') {
      // CAPI: Purchase server-side pro Meta (pixel 1560). event_id estável = dedup no Meta caso o
      // pixel client-side da página da Cakto também dispare Purchase.
      capiResult = await sendMetaPurchase({
        value: valor, email, phone: phoneRaw, fbp, fbc,
        eventId: 'cakto_' + (orderId || (phone_normalized || '') + '_' + (valor || '')),
        eventSourceUrl: 'https://eternizamemori.site/',
      });
      console.log('[cakto-webhook] capi', JSON.stringify(capiResult));
      if (!capiResult || !capiResult.ok) alertCapiFailOnce(capiResult); // 🚨 Purchase não foi pro Meta

      if (prevRank < RANK.pago) { // só na 1ª transição p/ pago (Cakto pode reenviar o webhook)
        // Discord: pinga o celular na hora que a venda cai
        await discord.notifyVendaAprovada({ valor, nome: name, phone: phoneRaw, email, gateway: 'Cakto', orderId }).catch(() => {});

        // === Confirmação automática no WhatsApp — 1x por pedido ===
        // Trava lógica (1ª transição p/ pago) + trava dura (coluna wa_confirm_sent_at) => sem duplicado.
        if (phone_normalized) {
          try {
            let oid = o.existed ? o.id : null, already = false, recip = null, nm = name;
            try {
              const rows = await sbSelect(`orders?phone_normalized=in.(${phoneCandidates(phone_normalized).join(',')})&select=id,wa_confirm_sent_at,recipient_name,customer_name&limit=1`);
              if (Array.isArray(rows) && rows[0]) { oid = rows[0].id; already = !!rows[0].wa_confirm_sent_at; recip = rows[0].recipient_name; nm = rows[0].customer_name || name; }
            } catch (e) { /* coluna wa_confirm_sent_at pode não existir ainda — segue só com a trava lógica */ }
            if (!already) {
              const waRes = await wa.enviarConfirmacao({ phone: phone_normalized, nome: nm, recipient_name: recip });
              console.log('[cakto-webhook] wa', JSON.stringify(waRes));
              if (waRes && waRes.ok) {
                if (oid) { try { await sbUpdate('orders', `id=eq.${encodeURIComponent(oid)}`, { wa_confirm_sent_at: new Date().toISOString() }); } catch (e) {} }
              } else if (waRes && !waRes.skipped) {
                await discord.notifyWaFalhou({ nome: nm, phone: phoneRaw, motivo: waRes.error || ('HTTP ' + waRes.status) }).catch(() => {});
              }
            }
          } catch (e) { console.error('[cakto-webhook] wa erro', String((e && e.message) || e).slice(0, 150)); }
        }
      }
    } else if (detected === 'recuperacao_pix' && prevRank < RANK.recuperacao_pix) {
      await discord.notifyPixGerado({ valor, nome: name, phone: phoneRaw, email, gateway: 'Cakto', orderId }).catch(() => {});
    }
    return res.status(200).json({ ok: true, capi: req.query.debug ? (capiResult || null) : undefined });
  } catch (e) {
    return res.status(500).json({ error: 'upsert_failed', detail: String(e.message || e).slice(0, 300) });
  }
};
