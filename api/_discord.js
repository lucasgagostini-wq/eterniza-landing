// Notificações Discord da Eterniza (reciclado do FotoJesus). URL/ID vêm do env
// (DISCORD_WEBHOOK_URL + DISCORD_USER_ID) — NUNCA hardcoded. Nunca lança:
// falha de notificação jamais quebra o webhook de pagamento.
const COLOR = { approved: 0xf5760a /* laranja fogo */, pix: 0x00a3e0 /* azul */ };

const fmtAmount = (a) => (a == null ? '—' : `R$ ${Number(a).toFixed(2).replace('.', ',')}`);
function fmtPhone(p) {
  if (!p) return '—';
  const d = String(p).replace(/\D/g, '').replace(/^55/, '');
  return d.length === 11 ? `+55 (${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : String(p);
}
const nowSP = () => new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/Sao_Paulo' });

// IDs a mencionar (pingam o celular). Padrão: Davi + Folha + Lucas (@agostini).
// ⚠️ Se a env DISCORD_USER_IDS (CSV) estiver setada no Vercel, ela SOBRESCREVE este default
// (então pra mudar a lista, ou edita aqui OU atualiza a env — não os dois pela metade).
const MENTION_IDS = (process.env.DISCORD_USER_IDS || '1080635336234909787,478692196178984960,319574831576252436')
  .split(',').map((s) => s.trim()).filter(Boolean);
const mention = () => (MENTION_IDS.length ? MENTION_IDS.map((id) => `<@${id}>`).join(' ') : undefined);

// envio de baixo nível — fire-and-forget, swallow de erro; ?wait=true retorna channel_id (debug) +
// allowed_mentions garante que a menção REALMENTE pingue (webhook não pinga sem isso).
async function send(embed, opts) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return { skipped: 'no_webhook_url' };
  const m = opts && opts.mention ? mention() : undefined;
  try {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'wait=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(m ? { content: m, allowed_mentions: { users: MENTION_IDS } } : {}),
        embeds: [{ timestamp: new Date().toISOString(), ...embed }],
      }),
      signal: AbortSignal.timeout(6000),
    });
    let info = {};
    try { const j = await r.json(); info = { channelId: j.channel_id, messageId: j.id }; } catch (e) {}
    return { ok: r.ok, status: r.status, ...info };
  } catch (e) { console.error('[discord] falhou', String((e && e.message) || e)); return { ok: false, error: String((e && e.message) || e).slice(0, 150) }; }
}

const fields = (p) => ([
  { inline: true, name: 'Valor', value: fmtAmount(p.valor) },
  { inline: true, name: 'Gateway', value: p.gateway || 'Yampi' },
  { inline: false, name: 'Comprador', value: p.nome || '—' },
  { inline: false, name: 'Telefone', value: fmtPhone(p.phone) },
  { inline: false, name: 'E-mail', value: p.email || '—' },
  { inline: false, name: 'Pedido', value: '`' + (p.orderId || '—') + '`' },
  { inline: false, name: 'Data', value: nowSP() },
]);

// 🔥 VENDA APROVADA — menciona o usuário (pinga o celular)
const notifyVendaAprovada = (p) => send({ title: '🔥 VENDA APROVADA — Eterniza', color: COLOR.approved, fields: fields(p) }, { mention: true });

// 🧾 PIX GERADO — info p/ recuperação (sem menção, não pinga)
const notifyPixGerado = (p) => send({ title: '🧾 Pix gerado — Eterniza', color: COLOR.pix, fields: fields(p) });

// ⚠️ CONFIRMAÇÃO AUTOMÁTICA FALHOU — pinga o time pra enviar manual (rede de segurança)
const notifyWaFalhou = (p) => send({
  title: '⚠️ Confirmação automática FALHOU — envie manual',
  color: 0xffcc00,
  fields: [
    { inline: false, name: 'Comprador', value: p.nome || '—' },
    { inline: false, name: 'Telefone', value: fmtPhone(p.phone) },
    { inline: false, name: 'Motivo', value: String(p.motivo || '—').slice(0, 200) },
    { inline: false, name: 'Data', value: nowSP() },
  ],
}, { mention: true });

// 🚨 WEBHOOK DE PAGAMENTO REJEITADO — token não bate (secret rotacionado sem atualizar no
// painel do gateway, ou config errada). Se isso disparar, TODA venda pode estar caindo fora
// do Hub sem registro algum — é o alerta mais crítico do sistema.
const notifyWebhookFalhou = (p) => send({
  title: '🚨 Webhook de pagamento REJEITADO — vendas podem não estar caindo no Hub',
  color: 0xff3b30,
  fields: [
    { inline: true, name: 'Gateway', value: p.gateway || '—' },
    { inline: false, name: 'Motivo', value: String(p.motivo || '—').slice(0, 200) },
    { inline: false, name: 'Data', value: nowSP() },
  ],
}, { mention: true });

// ⚠️ FOTO DO CLIENTE NÃO SALVOU — a prévia/pedido seguiu, mas a foto original pode ter
// se perdido; time precisa pedir a foto de novo pro cliente antes de produzir o vídeo.
const notifyFotoFalhou = (p) => send({
  title: '⚠️ Foto do cliente falhou ao salvar',
  color: 0xffcc00,
  fields: [
    { inline: false, name: 'Etapa', value: p.etapa || '—' },
    { inline: false, name: 'Nome (homenageado)', value: p.nome || '—' },
    { inline: false, name: 'Motivo', value: String(p.motivo || '—').slice(0, 200) },
    { inline: false, name: 'Data', value: nowSP() },
  ],
}, { mention: true });

// 🚨 CAPI FALHOU — a venda caiu no Hub mas o Purchase NÃO foi pro Meta (token inválido/ausente).
// Campanha pode metrificar 0 conversão mesmo vendendo — foi o que passou despercebido ~10h em 01/07.
const notifyCapiFalhou = (p) => send({
  title: '🚨 CAPI falhou — Purchase NÃO chegou no Meta (conversão pode zerar)',
  color: 0xff3b30,
  fields: [
    { inline: true, name: 'Gateway', value: p.gateway || '—' },
    { inline: false, name: 'Motivo', value: String(p.motivo || '—').slice(0, 300) },
    { inline: false, name: 'Data', value: nowSP() },
  ],
}, { mention: true });

// teste de integração (admin)
async function sendTest() {
  return send({ title: '🚀 TESTE — Eterniza', color: 0x00c06e, fields: [{ name: 'Status', value: '✅ Webhook Discord da Eterniza funcionando!' }, { name: 'Data', value: nowSP() }] }, { mention: true });
}

module.exports = { notifyVendaAprovada, notifyPixGerado, notifyWaFalhou, notifyFotoFalhou, notifyWebhookFalhou, notifyCapiFalhou, sendTest, MENTION_IDS };
