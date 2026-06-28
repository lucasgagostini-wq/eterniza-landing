// Disparo automático de WhatsApp da Eterniza (confirmação de pagamento).
// Espelha o padrão do _discord.js: fire-and-forget, NUNCA lança — falha de
// WhatsApp jamais quebra o webhook de pagamento.
//
// Usa uma instância Evolution API JÁ existente (a mesma que faz a recuperação).
// Config 100% por env no Vercel — NUNCA hardcoded:
//   EVOLUTION_API_URL   ex.: https://evo.seudominio.com   (sem barra no fim)
//   EVOLUTION_API_KEY   apikey global ou da instância
//   EVOLUTION_INSTANCE  nome da instância onde o número da recuperação está logado
//   WA_AUTOSEND=1       interruptor liga/desliga sem redeploy (qualquer outro valor = desligado)

const firstName = (n) => (n == null ? '' : String(n)).trim().split(/\s+/)[0] || '';

// Mensagem de confirmação — calorosa, humana, SEM link (reduz sinal de spam/ban).
// Mesmo texto do botão manual do hub (confirmMsg). Mantenha os dois em sincronia.
function buildConfirmText({ nome, recipient_name }) {
  const ola = firstName(nome) ? `Olá, ${firstName(nome)}!` : 'Olá!';
  const hom = recipient_name ? ` de *${recipient_name}*` : '';
  return `${ola} 🕊️\n\n` +
    `Recebi o pedido da homenagem${hom} com muito carinho. ❤️\n\n` +
    `Seu pagamento foi confirmado e já estamos trabalhando com toda atenção. ` +
    `Em até 24h você recebe o vídeo, a música e a arte aqui no seu WhatsApp.\n\n` +
    `Qualquer dúvida, é só me chamar! 🙏\n— Equipe Eterniza`;
}

const cfg = () => ({
  url: (process.env.EVOLUTION_API_URL || '').trim().replace(/\/+$/, ''),
  key: (process.env.EVOLUTION_API_KEY || '').trim(),
  instance: (process.env.EVOLUTION_INSTANCE || '').trim(),
  on: (process.env.WA_AUTOSEND || '').trim() === '1',
});

// só dígitos com DDI (normalizePhone já entrega 55DDXXXXXXXXX)
const onlyDigits = (p) => String(p || '').replace(/\D/g, '');

// Envio de baixo nível. Tenta o formato Evolution v2 (plano); se a instância for v1,
// faz 1 retry no formato antigo. Sempre devolve um objeto — nunca lança.
async function sendText({ phone, text, delay = 3000 }) {
  const c = cfg();
  if (!c.on) return { skipped: 'disabled' };               // WA_AUTOSEND != 1
  if (!c.url || !c.key || !c.instance) return { skipped: 'no_config' };
  const number = onlyDigits(phone);
  if (!number) return { skipped: 'no_phone' };

  const endpoint = `${c.url}/message/sendText/${encodeURIComponent(c.instance)}`;
  const headers = { apikey: c.key, 'Content-Type': 'application/json' };
  const v2 = { number, text, delay };
  const v1 = { number, options: { delay, presence: 'composing', linkPreview: false }, textMessage: { text } };

  const post = async (body) => {
    const r = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    const t = (await r.text().catch(() => '')).slice(0, 300);
    return { ok: r.ok, status: r.status, body: t };
  };

  try {
    let res = await post(v2);
    // 400/404 => instância provavelmente v1 (schema diferente). Tenta o formato antigo 1x.
    if (!res.ok && (res.status === 400 || res.status === 404)) {
      const alt = await post(v1).catch((e) => ({ ok: false, status: 0, body: String(e && e.message || e).slice(0, 200) }));
      if (alt.ok) return { ...alt, fmt: 'v1' };
      return { ...res, fmt: 'v2', altStatus: alt.status };
    }
    return { ...res, fmt: 'v2' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

// Confirmação de pagamento — a chamada que o webhook usa.
async function enviarConfirmacao({ phone, nome, recipient_name }) {
  return sendText({ phone, text: buildConfirmText({ nome, recipient_name }) });
}

module.exports = { enviarConfirmacao, sendText, buildConfirmText };
