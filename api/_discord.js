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
const mention = () => { const id = process.env.DISCORD_USER_ID; return id ? `<@${id}>` : undefined; };

// envio de baixo nível — fire-and-forget, swallow de erro; retorna status p/ debug
async function send(embed, opts) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return { skipped: 'no_webhook_url' };
  const m = opts && opts.mention ? mention() : undefined;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(m ? { content: m } : {}), embeds: [{ timestamp: new Date().toISOString(), ...embed }] }),
      signal: AbortSignal.timeout(6000),
    });
    return { ok: r.ok, status: r.status };
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

// teste de integração (admin)
async function sendTest() {
  return send({ title: '🚀 TESTE — Eterniza', color: 0x00c06e, fields: [{ name: 'Status', value: '✅ Webhook Discord da Eterniza funcionando!' }, { name: 'Data', value: nowSP() }] }, { mention: true });
}

module.exports = { notifyVendaAprovada, notifyPixGerado, sendTest };
