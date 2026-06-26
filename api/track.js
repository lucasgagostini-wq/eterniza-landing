// Tracking leve do funil. PÚBLICO + CORS (a landing e o bot pingam aqui).
// Fire-and-forget: grava 1 evento em funnel_events e nunca quebra o fluxo do cliente.
const { sbInsert } = require('./_lib');

// lista branca de passos (evita lixo no banco)
const STEPS = new Set([
  'pagina_venda', 'cta_clicou',
  'g1_abertura', 'g2_porquem', 'g3_nome', 'g4_memoria', 'g5_desejo', 'g6_video', 'g7_foto', 'g8_whatsapp',
  'go_cakto', 'go_yampi', // A/B de gateway: atribuição (quantos foram pra cada checkout)
  // funil /homenagem (prévia inline, sem bot)
  'h_hero', 'h_quiz', 'h_nome', 'h_memoria', 'h_whatsapp', 'h_foto', 'h_previa', 'h_checkout',
]);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const q = req.query || {};
  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};
  const step = String(q.step || b.step || '').trim();
  const sid = String(q.sid || b.sid || '').trim().slice(0, 80);
  // ignora silenciosamente o que não for válido (sem erro pro cliente)
  if (!STEPS.has(step) || !sid) return res.status(204).end();

  try {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      await sbInsert('funnel_events', { session_id: sid, step }, 'return=minimal');
    }
  } catch (e) { /* fire-and-forget: nunca propaga erro */ }
  return res.status(204).end();
};
